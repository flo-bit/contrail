import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN } from '../src/lib/config';
import { PENDING_COOKIE } from '../src/lib/server/auth';
import { pendingInvites } from '../src/lib/server/pending';
import { actions as inviteActions, load as inviteLoad } from '../src/routes/invite/[owner]/[rkey]/+page.server';
import { actions as eventActions, load as eventLoad } from '../src/routes/events/[owner]/[key]/+page.server';
import { actions as homeActions } from '../src/routes/+page.server';
import { GET as callback } from '../src/routes/oauth/callback/+server';
import { handle } from '../src/hooks.server';

const f = vi.hoisted(() => {
  const services = { invitations: { preview: vi.fn(), create: vi.fn(), revoke: vi.fn() }, accept: vi.fn(), rsvp: vi.fn(), readEvent: vi.fn(), createEvent: vi.fn() };
  return { services, getServices: vi.fn(() => services) };
});
vi.mock('../src/lib/server/prototype', () => ({ getServices: f.getServices }));
const owner = 'did:plc:alice';
const guest = { did: 'did:plc:bob', handle: vi.fn() };
const params = { owner, rkey: 'invite', key: '3h4oqw2vvxpwz' };
const path = `/events/${encodeURIComponent(owner)}/${params.key}`;
const secret = 'a'.repeat(43);
const preview = { name: 'Dinner', description: 'Bring bread.' };
function cookies() {
  const jar = new Map<string, string>();
  return { jar, get: (key: string) => jar.get(key), set: (key: string, value: string) => { jar.set(key, value); }, delete: (key: string) => { jar.delete(key); } };
}
function invoke(fn: unknown, input: unknown): Promise<unknown> {
  return Promise.resolve((fn as (input: unknown) => unknown)(input));
}
function request(form = new FormData(), origin = ORIGIN) {
  return new Request(`${ORIGIN}/invite/x/y`, { method: 'POST', headers: { origin }, body: form });
}
beforeEach(() => {
  vi.clearAllMocks();
  f.services.invitations.preview.mockResolvedValue(preview);
  f.services.accept.mockResolvedValue({ path });
});

describe('invitation HTTP boundaries', () => {
  it('does not preview, grant membership or write data on a fresh GET', async () => {
    expect(await invoke(inviteLoad, { cookies: cookies(), params })).toEqual({ preview: null, message: null });
    expect(f.getServices).not.toHaveBeenCalled();
  });
  it('exchanges the posted secret for an opaque cookie, then previews without acceptance', async () => {
    const jar = cookies();
    const form = new FormData(); form.set('secret', secret);
    expect(await invoke(inviteActions.preview, { request: request(form), cookies: jar, params })).toEqual({ preview });
    const key = jar.get(PENDING_COOKIE)!;
    expect(key).not.toContain(secret);
    expect(pendingInvites.get(key)).toEqual({ owner, rkey: params.rkey, secret });
    expect(await invoke(inviteLoad, { cookies: jar, params })).toEqual({ preview, message: null });
    expect(f.services.accept).not.toHaveBeenCalled();
    expect(f.services.rsvp).not.toHaveBeenCalled();
    expect(f.services.readEvent).not.toHaveBeenCalled();
  });
  it('requires a signed-in guest and the exact pending route for acceptance', async () => {
    const jar = cookies();
    jar.set(PENDING_COOKIE, pendingInvites.put({ owner, rkey: params.rkey, secret }));
    expect(await invoke(inviteActions.accept, { cookies: jar, locals: { session: null }, params })).toMatchObject({ status: 401 });
    expect(await invoke(inviteActions.accept, { cookies: jar, locals: { session: guest }, params: { ...params, rkey: 'different' } })).toMatchObject({ status: 400 });
    expect(f.services.accept).not.toHaveBeenCalled();
  });
  it('joins as the authenticated DID, ignores forged fields, and never implicitly RSVPs', async () => {
    const jar = cookies();
    const link = { owner, rkey: params.rkey, secret };
    const key = pendingInvites.put(link); jar.set(PENDING_COOKIE, key);
    const form = new FormData(); form.set('did', 'did:plc:mallory'); form.set('space', 'evil');
    await expect(invoke(inviteActions.accept, { request: request(form), cookies: jar, locals: { session: guest }, params })).rejects.toMatchObject({ status: 303, location: path });
    expect(f.services.accept).toHaveBeenCalledWith(guest, link);
    expect(f.services.rsvp).not.toHaveBeenCalled();
    expect(pendingInvites.get(key)).toBeUndefined();
    expect(jar.get(PENDING_COOKIE)).toBeUndefined();
  });
});

describe('private event HTTP boundaries', () => {
  it('does not read private records for an anonymous page request', async () => {
    expect(await invoke(eventLoad, { params, locals: { session: null } })).toMatchObject({ details: null });
    expect(f.getServices).not.toHaveBeenCalled();
  });
  it('blocks anonymous writes and non-host invitation administration', async () => {
    expect(await invoke(homeActions.create, { locals: { session: null } })).toMatchObject({ status: 401 });
    expect(await invoke(eventActions.rsvp, { params, locals: { session: null } })).toMatchObject({ status: 401 });
    expect(await invoke(eventActions.invite, { params, locals: { session: guest } })).toMatchObject({ status: 403 });
    expect(await invoke(eventActions.revoke, { params, locals: { session: guest } })).toMatchObject({ status: 403 });
    expect(f.getServices).not.toHaveBeenCalled();
  });
});

describe('request security', () => {
  function run(method: string, origin = ORIGIN, host = ORIGIN) {
    return invoke(handle, {
      event: { url: new URL(`${host}/`), request: new Request(`${host}/`, { method, headers: { origin } }), cookies: cookies(), locals: {} },
      resolve: async () => new Response('ok'),
    });
  }
  it('rejects cross-origin POSTs and wrong hosts', async () => {
    await expect(run('POST', 'https://evil.example')).rejects.toMatchObject({ status: 403 });
    await expect(run('GET', ORIGIN, 'http://evil.example:5175')).rejects.toMatchObject({ status: 403 });
  });
  it('marks responses private, uncached and non-referring', async () => {
    const response = await run('GET') as Response;
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
  it('rejects an OAuth callback not bound to this browser', async () => {
    await expect(invoke(callback, { url: new URL(`${ORIGIN}/oauth/callback?state=forged`), cookies: cookies() })).rejects.toMatchObject({ status: 400 });
  });
});
