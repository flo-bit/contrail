# Indexing

Contrail's core job: mirror atproto records into your DB and expose them via XRPC. You describe what to index with a config object; everything else is automatic.

## Collection shape

```ts
collections: {
  event: {
    collection: "community.lexicon.calendar.event", // full NSID
    queryable: {
      mode: {},                       // ?mode=online
      startsAt: { type: "range" },    // ?startsAtMin=...&startsAtMax=...
    },
    searchable: ["name", "description"], // FTS5 / tsvector
    relations: {
      rsvps: {
        collection: "rsvp",
        groupBy: "status",
        groups: { going: "community.lexicon.calendar.rsvp#going" },
      },
    },
    references: {
      event: { collection: "event", field: "subject.uri" },
    },
  },
}
```

- **queryable** — string equality or range, exposed as query params.
- **searchable** — FTS5 on D1/Postgres. Not available on `node:sqlite`.
- **relations** — materialized many-to-one counts (`rsvpsGoingCount`).
- **references** — forward lookups. Hydrate inline with `?hydrateEvent=true`.

## Ingestion

Three ways records land in the DB:

```ts
await contrail.ingest();           // one Jetstream cycle, then stops
await contrail.runPersistent();    // long-lived connection, auto-reconnect
await contrail.notify(uri);        // immediate PDS fetch for one record
```

Call `notify()` after your app writes to a PDS and needs the change reflected now. Jetstream catches the same event later; the duplicate is detected by CID.

## Discovery + backfill

```ts
await contrail.discover();                       // find users from relays
await contrail.backfill({ concurrency: 100 });   // pull their history
await contrail.sync();                           // both
```

## Querying

```ts
const { records, cursor } = await contrail.query("event", {
  filters: { mode: "online" },
  sort: { field: "startsAt", direction: "asc" },
  limit: 20,
});
```

Or via HTTP once the handler is mounted:

```
/xrpc/com.example.event.listRecords?mode=online&sort=startsAt&limit=20
/xrpc/com.example.event.getRecord?uri=at://did:plc:.../...
```

## Adapters

| Adapter | Use when | FTS |
|---|---|---|
| Cloudflare D1 | Workers | ✅ |
| `@atmo-dev/contrail/sqlite` | Node 22+ local dev | ❌ |
| `@atmo-dev/contrail/postgres` | Node server | ✅ |

```ts
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
const db = createPostgresDatabase(pool);
```

## Top-level config

| Key | Default | |
|---|---|---|
| `namespace` | — | Reverse-domain for XRPC paths |
| `profiles` | `["app.bsky.actor.profile"]` | Profile NSIDs, auto-hydrated via `?profiles=true` |
| `jetstreams` | Bluesky | Jetstream URLs |
| `relays` | Bluesky | Relay URLs for discovery |
| `notify` | off | `true` opens `notifyOfUpdate`; a string requires `Bearer` |
| `spaces` | — | See [Spaces](./spaces.md) |
| `community` | — | See [Communities](./communities.md) |
| `realtime` | — | See [Sync](./sync.md) |
