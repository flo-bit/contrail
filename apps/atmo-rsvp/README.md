# api.atmo.rsvp

Public Contrail read-through service for calendar events, RSVPs, actor profiles, and personalized network feeds. Records remain owned by their authors' PDSes; reads may acquire and cache missing public data.

Public discovery:

```text
https://api.atmo.rsvp/.well-known/contrail
https://api.atmo.rsvp/.well-known/did.json
https://api.atmo.rsvp/lexicons
https://api.atmo.rsvp/status
```

Anonymous XRPC queries:

```text
rsvp.atmo.getCursor
rsvp.atmo.getProfile
rsvp.atmo.event.getRecord
rsvp.atmo.event.listRecords
rsvp.atmo.rsvp.getRecord
rsvp.atmo.rsvp.listRecords
```

AT Protocol service-auth methods:

```text
rsvp.atmo.getFeed
rsvp.atmo.notifyOfUpdate
```

The base service DID is `did:web:api.atmo.rsvp`; the exact service-auth audience is `did:web:api.atmo.rsvp#contrail`. A consumer requests one least-privilege OAuth permission for both protected methods:

```text
rpc?aud=did:web:api.atmo.rsvp%23contrail&lxm=rsvp.atmo.getFeed&lxm=rsvp.atmo.notifyOfUpdate
```

Tokens remain method-bound. Call `com.atproto.server.getServiceAuth` with the specific `lxm` being invoked, then send its token as `Authorization: Bearer <token>`.

`getFeed` requires the requested actor to resolve to the token issuer. `notifyOfUpdate` accepts only AT URIs owned by the token issuer and always refetches their current authoritative state from that issuer's PDS. Notify is an authenticated cache hint, not a write proxy.

Event, RSVP, and feed reads can hydrate indexed actor profiles. Follows are an internal feed input: the service retains scoped follow records whose subjects are already in its acquisition scope rather than attempting to mirror or expose the network-wide social graph.

`getCursor` returns the committed opaque `{ source, epoch, cursor }` position of the primary Jetstream source. Clients compare complete positions for equality and fully refetch when the source or epoch changes.

The service has no user sessions and never signs or publishes records. Applications authenticate users and write through their PDSes.

## Meilisearch candidate generation

`src/meilisearch.ts` is the application-owned reference consumer for the transactional Contrail change log. It normalizes event documents, excludes cancelled events, restores direct geo/FSQ coordinates (with an injection seam for geocode-cache/H3 lookup), performs idempotent upsert/delete batches, and acknowledges only after every Meilisearch task reports `succeeded`.

`searchGenerationConfig` and `src/search-worker.ts` are intentionally separate from the active Worker configuration. Use them only with a fresh D1 generation and these runtime secrets:

```text
MEILI_URL
MEILI_KEY
MEILI_EVENTS_INDEX   # optional; defaults to atmo_events
```

Current-state bootstrap writes a token-scoped candidate index, catches up a fixed retained tail, then swaps it into the stable UID. A reserved generation marker makes activation idempotent even if the Worker dies after Meilisearch succeeds but before Contrail acknowledges activation. Search clients must filter `kind = event`, which excludes that control marker. The previous stable contents remain under the candidate UID for rollback handling.

Do not point the candidate config at the active populated D1 database: first-time logging fails closed there by design. Build/import a fresh candidate database, drain and verify the required `search` consumer, then switch the Worker/D1/index tuple together.

## Development

Build the workspace package before running the app directly:

```bash
pnpm --filter @atmo-dev/contrail build
pnpm --dir apps/atmo-rsvp lexicons:all
pnpm --dir apps/atmo-rsvp typecheck
pnpm --dir apps/atmo-rsvp dev
pnpm --dir apps/atmo-rsvp backfill:dev
```

The development backfill uses the local Wrangler/Miniflare D1 binding. It remains resumable and uses the same retry and completion logic as production ingestion.

## Deployment

```bash
pnpm --dir apps/atmo-rsvp lexicons:check
pnpm --dir apps/atmo-rsvp typecheck
pnpm --dir apps/atmo-rsvp deploy
```

Production bulk provisioning does not use Wrangler's remote development proxy. A fresh deployment generation is built with capture-first native SQLite snapshot/replay, verified, imported into a fresh D1 database, checked through a candidate Worker, and then activated by deploying the matching Worker/D1 binding together.

Consumer projects connect after installing Contrail:

```bash
pnpx @atmo-dev/contrail connect https://api.atmo.rsvp
```

That verifies the anonymous and service-auth contracts, verifies the canonical contract and Lexicon digests, writes a provider lock, installs provider-owned Lexicons, and runs Atcute TypeScript generation. Reconnecting an existing project requires `--update`.
