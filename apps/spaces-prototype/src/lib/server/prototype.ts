import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { createSqliteDatabase } from '@atmo-dev/contrail/sqlite';
import { createSpacesWorker } from '@atmo-dev/contrail-spaces-alpha/worker';
import { getDelegationToken } from '@atmo-dev/contrail-spaces-alpha/consumer';
import type { Did } from '@atcute/lexicons';
import { EVENT_COLLECTION, ORIGIN, RSVP_COLLECTION, SPACE_TYPE } from '../config';
import { getOAuth } from './auth';
import { createEventServices, type EventServices } from './events';
import { recordLexicons } from './lexicons';

let services: EventServices | undefined;
export function getServices(): EventServices {
  if (services) return services;
  const worker = createSpacesWorker({
    projection: {
      namespace: 'dev.contrail.prototype', profiles: [], constellation: false,
      collections: {
        event: { collection: EVENT_COLLECTION, validate: true },
        rsvp: { collection: RSVP_COLLECTION, validate: true },
      },
      validation: { verifyCid: true, strict: true },
    },
    lexicons: recordLexicons,
    service: { endpoint: ORIGIN, audience: 'did:web:localhost#spaces-prototype' },
    spaceTypes: { [SPACE_TYPE]: { collections: [EVENT_COLLECTION, RSVP_COLLECTION], policy: { $type: 'com.atproto.memberspace.policy' } } },
    notificationRegistration: 'disabled', // Loopback is not a reachable syncer service.
  });
  const env = { DB: createSqliteDatabase(':memory:'), SPACES_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  services = createEventServices({
    restoreOwnerSession: (did) => getOAuth().restore(did as Did),
    async connect(session, space) {
      const pending: Promise<unknown>[] = [];
      const runtime = worker.integrated(env, { waitUntil(task: Promise<unknown>) {
        pending.push(task);
        void task.catch(() => {}); // Awaited below, never an unhandled rejection.
      } } as ExecutionContext);
      await runtime.authorizeSpace({ userDid: session.did, space, delegation: await getDelegationToken(session, space) });
      // For a local prototype, finish reconciliation before returning the page.
      // No background service, queue or streaming optimization is required.
      await Promise.all(pending);
      return runtime;
    },
  });
  return services;
}
