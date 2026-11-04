import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPdsSession } from '@atmo-dev/contrail-spaces-alpha/consumer';
import type { IntegratedSpacesRuntime } from '@atmo-dev/contrail-spaces-alpha/worker';
import { formatSpaceUri, parseSpaceUri } from '@atmo-dev/contrail-spaces-alpha';
import { createSpaceRecordValidation } from '../../../packages/contrail-spaces-alpha/src/validation';
import { createEventServices, eventInput } from '../src/lib/server/events';
import { recordLexicons } from '../src/lib/server/lexicons';
import { EVENT_COLLECTION, RSVP_COLLECTION, SPACE_TYPE, CONTROL_TYPE, INVITATION_COLLECTION } from '../src/lib/config';

const owner = 'did:plc:alice';
const guest = 'did:plc:bob';
const stranger = 'did:plc:mallory';
const cid = 'bafyreiclp443lav4udnztz7msp6j2wkxwp4m5mns2njm6zq7so4au6druq';
function fixture() {
  type Stored = { uri: string; cid: string; did: string; value: Record<string, unknown> };
  const spaces = new Map<string, { owner: string; policy: Record<string, unknown>; members: Set<string> }>();
  const records = new Map<string, Stored>();
  const calls: { did: string; method: string; body: Record<string, unknown> }[] = [];
  const keyFor = (space: string, repo: string, collection: string, rkey: string) => `${space}/${repo}/${collection}/${rkey}`;
  const session = (did: string): AuthenticatedPdsSession => ({ did, async handle(path, init) {
    const url = new URL(path, 'https://fake-pds.invalid');
    const method = url.pathname.split('/').at(-1)!;
    const body = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
    calls.push({ did, method, body });
    const fail = (error: string) => Response.json({ error }, { status: 400 });
    if (method === 'com.atproto.space.createSpace') {
      const uri = formatSpaceUri({ authorityDid: did, type: body.spaceType, skey: body.skey });
      if (spaces.has(uri)) return fail('SpaceAlreadyExists');
      spaces.set(uri, { owner: did, policy: body.policy, members: new Set() });
      return Response.json({ uri });
    }
    if (method === 'com.atproto.space.listSpaces') {
      return Response.json({ spaces: [...spaces].filter(([uri, space]) => parseSpaceUri(uri).type === body.spaceType && (space.owner === did || [...records.values()].some((r) => r.did === did && r.uri.startsWith(uri + '/')))).map(([uri]) => ({ uri })) });
    }
    const space = spaces.get(body.space);
    if (!space) return fail('SpaceNotFound');
    if (method === 'com.atproto.memberspace.putMember') {
      if (did !== space.owner) return fail('Forbidden');
      space.members.add(body.did);
      return Response.json({});
    }
    if (method === 'com.atproto.space.getSpace') {
      if (did !== space.owner) return fail('Forbidden');
      return Response.json({ uri: body.space, policy: space.policy });
    }
    if (did !== space.owner && !space.members.has(did)) return fail('Forbidden');
    const key = keyFor(body.space, body.repo, body.collection, body.rkey);
    if (method === 'com.atproto.space.createRecord' || method === 'com.atproto.space.putRecord') {
      if (body.repo !== did) return fail('Forbidden');
      records.set(key, { uri: key, cid, did, value: body.record });
      return Response.json({ uri: key, cid });
    }
    if (method === 'com.atproto.space.deleteRecord') {
      if (body.repo !== did) return fail('Forbidden');
      records.delete(key);
      return Response.json({});
    }
    if (method === 'com.atproto.space.getRecord') return records.has(key) ? Response.json(records.get(key)) : fail('RecordNotFound');
    throw new Error(`Unexpected fake PDS method: ${method}`);
  } });
  const restore = vi.fn(async (did: string) => session(did));
  const connect = vi.fn(async (user: AuthenticatedPdsSession, uri: string) => {
    const space = spaces.get(uri)!;
    if (user.did !== space.owner && !space.members.has(user.did)) throw new Error('Forbidden');
    return {
      getSpaceRecord: vi.fn(async ({ uri }: { uri: string }) => ({ record: records.get(uri) })),
      listSpaceRecords: vi.fn(async ({ collection }: { collection: string }) => ({
        records: [...records.values()].filter((record) => record.uri.startsWith(uri + '/') && record.value.$type === collection),
        references: {},
      })),
    } as unknown as IntegratedSpacesRuntime;
  });
  const services = createEventServices({ connect, restoreOwnerSession: restore });
  return { services, session, spaces, records, calls, restore, connect };
}
const input = { name: 'Dinner', description: 'Bring something to share.', startsAt: '2026-11-01T19:00:00.000Z' };

describe('local prototype event flow (fake PDS only)', () => {
  it('creates a private memberspace and a canonical, owner-written event', async () => {
    const f = fixture();
    const address = await f.services.createEvent(f.session(owner), input);
    expect(f.spaces.get(address.space)?.policy).toEqual({ $type: 'com.atproto.memberspace.policy', publishPolicy: true });
    expect(f.records.get(address.uri)?.did).toBe(owner);
    expect(f.records.get(address.uri)?.value).toMatchObject({ $type: EVENT_COLLECTION, ...input });
    const validation = createSpaceRecordValidation(recordLexicons, [EVENT_COLLECTION, RSVP_COLLECTION]);
    await validation.ready;
    expect(await validation.validate({ collection: EVENT_COLLECTION, rkey: address.key, record: f.records.get(address.uri)!.value, strict: true })).toBe(true);
  });

  it('previews safe event fields, stores only a verifier, and does not join or RSVP', async () => {
    const f = fixture();
    const address = await f.services.createEvent(f.session(owner), input);
    const link = await f.services.invitations.create(f.session(owner), address);
    expect(await f.services.invitations.preview(link)).toEqual(input);
    expect(f.spaces.get(address.space)?.members.size).toBe(0);
    expect(f.calls.some((call) => call.method === 'com.atproto.memberspace.putMember')).toBe(false);
    expect(f.calls.some((call) => call.body.collection === RSVP_COLLECTION)).toBe(false);
    const control = [...f.spaces].find(([uri]) => parseSpaceUri(uri).type === CONTROL_TYPE)!;
    expect(control[1].policy).toEqual({ $type: 'com.atproto.personalspace.policy' });
    const definition = [...f.records.values()].find((record) => record.value.$type === INVITATION_COLLECTION)!;
    expect(definition.uri.startsWith(control[0] + '/')).toBe(true);
    expect(JSON.stringify(definition)).not.toContain(link.secret);
    expect(definition.value.secretHash).toHaveLength(43);
  });

  it('restores the offline host, joins the authenticated guest, then writes a separate idempotent RSVP', async () => {
    const f = fixture();
    const address = await f.services.createEvent(f.session(owner), input);
    const link = await f.services.invitations.create(f.session(owner), address);
    await expect(f.services.readEvent(f.session(stranger), address)).rejects.toThrow('Forbidden');
    await f.services.accept(f.session(guest), link);
    expect(f.restore).toHaveBeenCalledWith(owner);
    expect(f.spaces.get(address.space)?.members).toEqual(new Set([guest]));
    expect([...f.records.values()].some((r) => r.value.$type === RSVP_COLLECTION)).toBe(false);
    await f.services.rsvp(f.session(guest), address, 'going');
    await f.services.rsvp(f.session(guest), address, 'notgoing');
    const rsvps = [...f.records.values()].filter((r) => r.value.$type === RSVP_COLLECTION);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({ did: guest, value: { subject: { uri: address.uri, cid }, status: `${RSVP_COLLECTION}#notgoing` } });
    const validation = createSpaceRecordValidation(recordLexicons, [EVENT_COLLECTION, RSVP_COLLECTION]);
    await validation.ready;
    expect(await validation.validate({ collection: RSVP_COLLECTION, rkey: address.key, record: rsvps[0].value, strict: true })).toBe(true);
    expect((await f.services.readEvent(f.session(owner), address)).attendees).toEqual([{ did: guest, status: 'notgoing' }]);
    expect((await f.services.listEvents(f.session(guest))).events[0]?.path).toBe(address.path);
  });

  it('ignores extra RSVP keys so a writer cannot create duplicate response rows', async () => {
    const f = fixture();
    const address = await f.services.createEvent(f.session(owner), input);
    await f.services.rsvp(f.session(owner), address, 'going');
    const original = [...f.records.values()].find((record) => record.value.$type === RSVP_COLLECTION)!;
    f.records.set(original.uri + '-extra', { ...original, uri: original.uri + '-extra' });
    expect((await f.services.readEvent(f.session(owner), address)).attendees).toEqual([{ did: owner, status: 'going' }]);
  });

  it('revokes new joins without ejecting members or changing their RSVP', async () => {
    const f = fixture();
    const address = await f.services.createEvent(f.session(owner), input);
    const link = await f.services.invitations.create(f.session(owner), address);
    await f.services.accept(f.session(guest), link);
    await f.services.rsvp(f.session(guest), address, 'going');
    await f.services.invitations.revoke(f.session(owner), link.rkey);
    await expect(f.services.accept(f.session(stranger), link)).rejects.toThrow();
    expect(f.spaces.get(address.space)?.members).toEqual(new Set([guest]));
    expect((await f.services.readEvent(f.session(guest), address)).attendees[0].status).toBe('going');
  });

  it('does not write after a rejected read authorization or invalid RSVP', async () => {
    const f = fixture();
    const address = await f.services.createEvent(f.session(owner), input);
    await expect(f.services.rsvp(f.session(stranger), address, 'going')).rejects.toThrow();
    await expect(f.services.rsvp(f.session(owner), address, 'surprise' as 'going')).rejects.toThrow('Choose a valid RSVP.');
    expect(f.calls.some((call) => call.body.collection === RSVP_COLLECTION)).toBe(false);
  });
});

describe('event input', () => {
  it('trims text and accepts optional fields', () => {
    const form = new FormData(); form.set('name', ' Dinner ');
    expect(eventInput(form)).toEqual({ name: 'Dinner' });
    form.set('startsAt', '2026-11-01T19:00:00.000Z');
    expect(eventInput(form).startsAt).toBe('2026-11-01T19:00:00.000Z');
  });
  it('rejects empty names, long text and invalid dates', () => {
    const form = new FormData();
    expect(() => eventInput(form)).toThrow();
    form.set('name', 'x'.repeat(121)); expect(() => eventInput(form)).toThrow();
    form.set('name', 'Dinner'); form.set('description', 'x'.repeat(2001)); expect(() => eventInput(form)).toThrow();
    form.delete('description'); form.set('startsAt', 'not a date'); expect(() => eventInput(form)).toThrow();
  });
});
