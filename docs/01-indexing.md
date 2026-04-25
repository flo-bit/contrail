# Indexing

Contrail's core job: mirror atproto records into your DB and expose them via XRPC. You describe what to index with a config object; everything else is automatic.

## Collection shape

A realistic two-collection example: events and RSVPs. RSVPs point at events via `subject.uri`; events expose per-status RSVP counts.

```ts
collections: {
  event: {
    collection: "community.lexicon.calendar.event", // full NSID
    queryable: {
      mode: {},                          // ?mode=online
      startsAt: { type: "range" },       // ?startsAtMin=...&startsAtMax=...
    },
    searchable: ["name", "description"], // FTS5 / tsvector
    relations: {
      rsvps: {
        collection: "rsvp",              // short name of the child collection
        groupBy: "status",               // field on the child record
        groups: {
          going: "community.lexicon.calendar.rsvp#going",
          interested: "community.lexicon.calendar.rsvp#interested",
        },
      },
    },
  },
  rsvp: {
    collection: "community.lexicon.calendar.rsvp",
    queryable: { status: {} },
    references: {
      event: { collection: "event", field: "subject.uri" }, // RSVP's field → event's URI
    },
  },
}
```

- **queryable** — string equality or range, exposed as query params.
- **searchable** — FTS5 on D1/Postgres. Not available on `node:sqlite`.
- **relations** — many-to-one with materialized counts. The `event` collection gains `rsvpsCount`, `rsvpsGoingCount`, `rsvpsInterestedCount` columns — filter (`?rsvpsGoingCountMin=10`) and sort (`?sort=rsvpsGoingCount`) on them. Hydrate inline with `?hydrateRsvps=5`.
- **references** — forward lookups from child → parent. `?hydrateEvent=true` on an RSVP query embeds the referenced event record.

## Backfill (historical data)

Run once at setup to pull every record that exists today.

```ts
await contrail.backfillAll({ concurrency: 100 }); // discover + backfill, logs progress
```

Under the hood this is two steps you can call separately if you want finer control:

```ts
await contrail.discover();                     // walk relays, register DIDs
await contrail.backfill({ concurrency: 100 }); // fetch history for registered DIDs
```

`backfill()` picks up where it left off across runs — safe to re-run.

### Workers CLI

For Cloudflare Workers deploys, `@atmo-dev/contrail` ships a `contrail` bin that handles the `wrangler.getPlatformProxy` dance — no script file, no package.json alias needed:

```bash
pnpm contrail backfill           # local D1 (wrangler dev's bindings)
pnpm contrail backfill --remote  # production D1
```

Auto-detects configs at `contrail.config.ts`, `src/contrail.config.ts`, `src/lib/contrail.config.ts`, or `app/contrail.config.ts` (first match wins). Override with `--config <path>`. Other flags: `--binding <name>` (default `DB`), `--concurrency <n>` (default 100).

If you'd rather embed backfill inside your own script, `@atmo-dev/contrail/workers` exports the same logic as a function:

```ts
import { backfillAll } from "@atmo-dev/contrail/workers";
import { config } from "../src/contrail.config";

await backfillAll({ config, remote: process.argv.includes("--remote") });
```

For node/postgres deploys, skip both — you already have a `db` in hand; just `await contrail.backfillAll({}, db)` directly.

## Ingestion (ongoing new records)

After the initial `backfillAll()`, keep the index fresh with new records as they're published. Pick the mode that matches your runtime.

### Cron-driven (cloudflare workers)

Workers can't hold long-lived connections, so run one catch-up cycle per cron fire:

```ts
// wrangler.jsonc: "triggers": { "crons": ["*/1 * * * *"] }
async scheduled(_ev, env, ctx) {
  ctx.waitUntil(contrail.ingest({}, env.DB));
}
```

`ingest()` connects to Jetstream, streams events since the saved cursor, stops when caught up. Running every minute is fine — the next fire resumes where this one left off. Each cycle is bounded, so it can't blow past the Worker time limit.

**Local dev:** wrangler's cron scheduler only runs in deployed production. For local dev use `pnpm contrail dev` — it runs `wrangler dev --test-scheduled`, fires `/__scheduled` on your configured cron interval, and prompts you to run backfill or refresh if the local DB looks stale on start.

### Persistent (node / any long-lived server)

If your runtime can keep a socket open, skip the cron entirely:

```ts
const ac = new AbortController();
await contrail.runPersistent({
  batchSize: 50,         // flush every N events (default: 50)
  flushIntervalMs: 5000, // or every N ms, whichever first
  signal: ac.signal,
});
// ac.abort() flushes the current batch and saves the cursor before returning
```

One process, one socket, auto-reconnect on drops. Lower latency than cron mode (events land within seconds instead of up-to-a-minute), but needs a runtime that can run indefinitely.

### Immediate (`notify()`)

Use this when your own app writes to a user's PDS and needs the change indexed *now* — waiting for the next cron / Jetstream flush is too slow:

```ts
await contrail.notify(uri);           // one record
await contrail.notify([u1, u2, u3]);  // batch, up to 25
```

Fetches directly from the user's PDS and indexes synchronously. When Jetstream later delivers the same event, the duplicate is detected by CID and skipped.

### Which one do I use?

| | backfillAll | ingest | runPersistent | notify |
|---|---|---|---|---|
| when | once, at setup | every cron fire | start once, runs forever | per-write, on demand |
| runtime | local script | cloudflare workers | node / long-lived server | anywhere |
| scope | all historical records | events since last cursor | events since last cursor, live | specific URIs |
| latency | — | ~minute | ~seconds | immediate |

Typical combos:
- **workers app:** `backfillAll()` once + `ingest()` on cron + optional `notify()` for self-writes
- **node server:** `backfillAll()` once + `runPersistent()` forever + optional `notify()` for self-writes

## Refresh (catch-up after outages / dev idle)

When Jetstream drops events — you went offline for a few days in dev, there was an outage, or you just want reassurance nothing was lost — `refresh` walks every known DID's PDS and reconciles against your DB:

```bash
pnpm contrail refresh                    # totals only
pnpm contrail refresh --by-collection    # totals + per-collection breakdown
pnpm contrail refresh --ignore-window 30 # grace seconds (default: 60)
```

Each record is classified as:

- **missing** — PDS has it, DB doesn't. Inserted.
- **stale update** — DB has it with a different CID, *and* the DB row is older than the ignore window. Upserted.
- **in sync** — same CID, or DB row is within the ignore window (jetstream probably just hadn't caught up yet).

The ignore window is there so a refresh run seconds after a normal jetstream cycle doesn't double-count records that are about to sync anyway. Records inside the window are still written if they differ; they just don't show up in the stats.

Report shape (`--by-collection`):

```
by collection:
  community.lexicon.calendar.event
    3 missing, 1 stale updates, 842 in sync
  community.lexicon.calendar.rsvp
    12 missing, 0 stale updates, 4108 in sync

total:
  15 missing, 1 stale updates, 4950 in sync
  234 users scanned, 1 failed in 85.3s
  (ignore window: 60s)
```

Safe to run repeatedly — each pass converges toward zero missing / stale. Programmatic equivalent: `contrail.refresh({ ignoreWindowMs, concurrency })` returns the same structure.

Refresh is **not** a replacement for `ingest`/`runPersistent` — it walks every user's full history, which is expensive. Use it after outages or during dev idle, not as a continuous freshness mechanism.

Reading the indexed data — filters, sorts, hydration, search, pagination — has its own doc: [Querying](./02-querying.md).

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
| `spaces` | — | See [Spaces](./05-spaces.md) |
| `community` | — | See [Communities](./06-communities.md) |
| `realtime` | — | See [Sync](./07-sync.md) |
| `labels` | — | See [Labels](./08-labels.md) |
