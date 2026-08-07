# api.atmo.rsvp

Anonymous public Contrail read-through service for calendar events and RSVPs. Records remain owned by their authors' PDSes; reads may acquire and cache missing public data.

Public discovery:

```text
https://api.atmo.rsvp/.well-known/contrail
https://api.atmo.rsvp/lexicons
https://api.atmo.rsvp/status
```

Typed XRPC methods:

```text
rsvp.atmo.getCursor
rsvp.atmo.event.getRecord
rsvp.atmo.event.listRecords
rsvp.atmo.rsvp.getRecord
rsvp.atmo.rsvp.listRecords
```

`getCursor` returns the committed opaque `{ source, epoch, cursor }` position of the primary Jetstream source. Clients compare complete positions for equality and fully refetch when the source or epoch changes.

The service has no user sessions, service DID, or write proxy. Applications authenticate and write through users' PDSes.

## Development

```bash
pnpm --dir apps/atmo-rsvp lexicons:all
pnpm --dir apps/atmo-rsvp typecheck
pnpm --dir apps/atmo-rsvp dev
pnpm --dir apps/atmo-rsvp backfill:dev
```

The development backfill uses the local Wrangler/Miniflare D1 binding. It remains resumable and uses the same validation, retry, and completion logic as production ingestion.

## Deployment

```bash
pnpm --dir apps/atmo-rsvp lexicons:check
pnpm --dir apps/atmo-rsvp typecheck
pnpm --dir apps/atmo-rsvp deploy
```

The deployed D1 database is already provisioned. Production bulk provisioning does not use Wrangler's remote development proxy. The planned repeatable workflow builds and verifies a fresh native SQLite generation, imports canonical tables into a fresh D1 database, rebuilds derived projections, verifies readiness, and then activates it.

Consumer projects connect after installing Contrail:

```bash
pnpm contrail connect https://api.atmo.rsvp
```

That verifies the canonical service and Lexicon digests, writes a provider lock, installs the provider-owned Lexicons, and runs Atcute TypeScript generation. Reconnecting an existing project requires `--update`.
