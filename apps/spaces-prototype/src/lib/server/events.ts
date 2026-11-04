import { now, validate as isTid } from '@atcute/tid';
import {
  createSpace, createSpaceRecord, pdsProcedure, pdsQuery,
  type AuthenticatedPdsSession,
} from '@atmo-dev/contrail-spaces-alpha/consumer';
import { createSpaceInvitations, type InvitationLink } from '@atmo-dev/contrail-spaces-alpha/invitations';
import { formatSpaceUri, formatSpaceRecordUri, parseSpaceUri, parseSpaceRecordUri } from '@atmo-dev/contrail-spaces-alpha';
import type { IntegratedSpacesRuntime } from '@atmo-dev/contrail-spaces-alpha/worker';
import {
  CONTROL_TYPE, EVENT_COLLECTION, INVITATION_COLLECTION, RSVP_COLLECTION, SPACE_TYPE,
  type EventRecord, type RecordView, type RsvpRecord, type RsvpStatus,
} from '../config';
import { InputError } from './messages';

export function eventAddress(owner: string, key: string) {
  if (!isTid(key)) throw new InputError('Invalid event address.');
  const space = formatSpaceUri({ authorityDid: owner, type: SPACE_TYPE, skey: key });
  const uri = formatSpaceRecordUri({ spaceUri: space, writerDid: owner, collection: EVENT_COLLECTION, rkey: key });
  return { owner, key, space, uri, path: `/events/${encodeURIComponent(owner)}/${key}` };
}
export type EventAddress = ReturnType<typeof eventAddress>;

export function eventInput(form: FormData): Omit<EventRecord, '$type' | 'createdAt'> {
  const name = String(form.get('name') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const startsAt = String(form.get('startsAt') ?? '');
  if (!name || name.length > 120) throw new InputError('Enter an event name, up to 120 characters.');
  if (description.length > 2000) throw new InputError('Keep the details under 2,000 characters.');
  if (startsAt && (!/^\d{4}-\d{2}-\d{2}T/.test(startsAt) || !Number.isFinite(Date.parse(startsAt)))) throw new InputError('Choose a valid date and time.');
  return { name, ...(description ? { description } : {}), ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}) };
}

export function createEventServices(options: {
  connect(session: AuthenticatedPdsSession, space: string): Promise<IntegratedSpacesRuntime>;
  restoreOwnerSession(did: string): Promise<AuthenticatedPdsSession>;
}) {
  const invitations = createSpaceInvitations({
    controlSpaceType: CONTROL_TYPE,
    invitationCollection: INVITATION_COLLECTION,
    targets: { [SPACE_TYPE]: [EVENT_COLLECTION] },
    restoreOwnerSession: options.restoreOwnerSession,
    async preview(target, owner) {
      const { rkey } = parseSpaceRecordUri(target.uri);
      const { value } = await pdsQuery<{ value: EventRecord }>(owner, 'com.atproto.space.getRecord', {
        space: target.space, repo: owner.did, collection: EVENT_COLLECTION, rkey,
      });
      if (value.$type !== EVENT_COLLECTION || typeof value.name !== 'string') throw new InputError('Event unavailable.');
      // Deliberately selected fields: no raw records, references or attendees.
      return { name: value.name, description: value.description, startsAt: value.startsAt };
    },
  });

  async function readEvent(session: AuthenticatedPdsSession, address: EventAddress) {
    const runtime = await options.connect(session, address.space);
    const { record } = await runtime.getSpaceRecord<RecordView<EventRecord>>({
      userDid: session.did, space: address.space, collection: EVENT_COLLECTION, uri: address.uri,
    });
    const result = await runtime.listSpaceRecords<RecordView<RsvpRecord>>({
      userDid: session.did, space: address.space, collection: RSVP_COLLECTION, limit: 100,
    });
    const attendees = result.records.filter((row) => row.value.subject.uri === address.uri &&
      row.uri === formatSpaceRecordUri({ spaceUri: address.space, writerDid: row.did, collection: RSVP_COLLECTION, rkey: address.key }))
      .map((row) => ({ did: row.did, status: ['going', 'notgoing', 'interested'].find((status) => row.value.status === `${RSVP_COLLECTION}#${status}`) ?? 'other' }));
    return { address, event: record.value, cid: record.cid, attendees, truncated: Boolean(result.cursor) };
  }

  return {
    invitations,
    readEvent,
    async createEvent(session: AuthenticatedPdsSession, input: ReturnType<typeof eventInput>) {
      const address = eventAddress(session.did, now());
      await createSpace(session, { spaceType: SPACE_TYPE, skey: address.key,
        policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true } });
      await createSpaceRecord(session, { space: address.space, collection: EVENT_COLLECTION, rkey: address.key,
        record: { $type: EVENT_COLLECTION, ...input, createdAt: new Date().toISOString() } });
      return address;
    },
    async listEvents(session: AuthenticatedPdsSession) {
      const result = await pdsQuery<{ spaces: { uri: string }[]; cursor?: string }>(session, 'com.atproto.space.listSpaces', { spaceType: SPACE_TYPE, limit: '20' });
      const events: { path: string; name: string; startsAt?: string; hosting: boolean }[] = [];
      let unavailable = false;
      for (const candidate of result.spaces) {
        try {
          const parsed = parseSpaceUri(candidate.uri);
          if (parsed.type !== SPACE_TYPE) continue;
          const address = eventAddress(parsed.authorityDid, parsed.skey);
          const event = await readEvent(session, address);
          events.push({ path: address.path, name: event.event.name, startsAt: event.event.startsAt, hosting: address.owner === session.did });
        } catch { unavailable = true; } // Never treat a failed read as deletion.
      }
      return { events, unavailable, truncated: Boolean(result.cursor) };
    },
    async rsvp(session: AuthenticatedPdsSession, address: EventAddress, status: RsvpStatus) {
      if (status !== 'going' && status !== 'notgoing') throw new InputError('Choose a valid RSVP.');
      const event = await readEvent(session, address);
      // One deterministic TID per event, in the authenticated writer's own repo.
      return pdsProcedure(session, 'com.atproto.space.putRecord', {
        space: address.space, repo: session.did, collection: RSVP_COLLECTION, rkey: address.key,
        record: { $type: RSVP_COLLECTION, subject: { uri: address.uri, cid: event.cid }, status: `${RSVP_COLLECTION}#${status}` },
      });
    },
    async accept(session: AuthenticatedPdsSession, link: InvitationLink) {
      // Membership first. RSVP is a separate operation on the event page.
      const target = await invitations.accept(session, link);
      const parsed = parseSpaceUri(target.space);
      return eventAddress(parsed.authorityDid, parsed.skey);
    },
  };
}
export type EventServices = ReturnType<typeof createEventServices>;
