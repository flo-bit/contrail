# Contrail

> [!WARNING]
> Work in progress! Pre-alpha, expect breaking changes.

A library for indexing AT Protocol records. Define collections — get automatic Jetstream ingestion, PDS backfill, user discovery, typed XRPC endpoints, and (opt-in) permissioned spaces for private records. Works with Cloudflare Workers + D1, SvelteKit, Node.js, or any JavaScript runtime.

## Install

```bash
npm install @atmo-dev/contrail
```

## Usage

```ts
import { Contrail } from "@atmo-dev/contrail";

const contrail = new Contrail({
  namespace: "com.example",
  db, // any Database-compatible instance (D1, SQLite, etc.)
  collections: {
    event: {                                         // short name → URL path + table suffix
      collection: "community.lexicon.calendar.event", // full NSID of the record type
      queryable: {
        mode: {},                        // string → equality filter (?mode=online)
        name: {},                        // string → equality filter (?name=...)
        startsAt: { type: "range" },     // range → min/max filters (?startsAtMin=...&startsAtMax=...)
        endsAt: { type: "range" },
      },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "rsvp",            // short name of the child collection
          groupBy: "status",
          count: true,
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
          },
        },
      },
    },
    rsvp: {
      collection: "community.lexicon.calendar.rsvp",
      queryable: {
        status: {},
        "subject.uri": {},
      },
      references: {
        event: {
          collection: "event",          // short name of the referenced collection
          field: "subject.uri",
        },
      },
    },
  },
});

await contrail.init();
```

### Query records

```ts
const { records, cursor } = await contrail.query(
  "event",                        // short name you declared in `collections`
  {
    filters: { mode: "in-person" },
    sort: { countType: "rsvp", direction: "desc" },
    limit: 20,
  }
);
```

### Ingest from Jetstream

```ts
// Run one ingestion cycle (catches up to present, then stops)
await contrail.ingest();
```

### Persistent ingestion

```ts
// Long-lived Jetstream connection with automatic batching and reconnection
const controller = new AbortController();
await contrail.runPersistent({
  batchSize: 50,           // flush every N events (default: 50)
  flushIntervalMs: 5000,   // or every N ms (default: 5000)
  signal: controller.signal,
});
```

Call `controller.abort()` for graceful shutdown — the current batch is flushed and the cursor is saved.

### Discover users and backfill

```ts
// Find users from relays
await contrail.discover();

// Backfill their records from PDS
await contrail.backfill({ concurrency: 100 });

// Or both in one call
await contrail.sync({ concurrency: 100 });
```

### Notify of immediate updates

```ts
// After writing to a user's PDS, tell Contrail to fetch it now
await contrail.notify("at://did:plc:abc/community.lexicon.calendar.rsvp/123");

// Batch up to 25 URIs
await contrail.notify([uri1, uri2, uri3]);
```

### HTTP handler (XRPC endpoints)

Mount the full XRPC API in any framework:

```ts
import { createHandler } from "@atmo-dev/contrail/server";

const handle = createHandler(contrail);
// handle: (Request, db?) => Promise<Response>
```

**SvelteKit:**

```ts
// src/routes/xrpc/[...path]/+server.ts
export const GET = ({ request }) => handle(request);
export const POST = ({ request }) => handle(request);
```

**Cloudflare Worker:**

```ts
export default {
  async fetch(request, env) {
    return handle(request, env.DB);
  },
};
```

### SQLite adapter (Node.js / local dev)

```ts
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";

const db = createSqliteDatabase("data.db");
const contrail = new Contrail({ ...config, db });
```

> **Note:** The SQLite adapter uses Node's built-in `node:sqlite` (Node 22+). Full-text search (`searchable`) is not supported with this adapter because `node:sqlite` doesn't include the FTS5 extension. Search works on Cloudflare D1 and PostgreSQL.

### PostgreSQL adapter (Node.js / server)

```ts
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = createPostgresDatabase(pool);
const contrail = new Contrail({ ...config, db });
```

PostgreSQL uses JSONB for record storage, tsvector generated columns for full-text search (instead of FTS5), and `BIGINT` for timestamp columns.

## Examples

### PostgreSQL (Node.js)

See [`examples/postgres/`](examples/postgres/) for a complete example with Docker Compose, persistent Jetstream ingestion, user discovery/backfill, and an HTTP API server.

### Cloudflare Workers

This repo includes a working example that indexes AT Protocol calendar events and RSVPs on Cloudflare Workers + D1.

### Setup

```bash
pnpm install
pnpm generate:pull   # pull lexicons from network, auto-detect fields, generate types
```

### Dev

```bash
pnpm sync            # discover users and backfill records from PDS
pnpm dev:auto        # start wrangler dev with auto-ingestion
```

### Production

```bash
npx wrangler d1 create contrail
# Add database_id to wrangler.jsonc
pnpm deploy
pnpm sync            # discover + backfill against prod D1
```

Ingestion runs automatically via cron (`*/1 * * * *`). Schema is auto-initialized.

## Config

### Collection options

| Option | Default | Description |
|--------|---------|-------------|
| `queryable` | `{}` | Fields exposed as query filters. `{}` = string equality, `{ type: "range" }` = min/max |
| `discover` | `true` | Find users via relays. `false` = only track known DIDs |
| `relations` | `{}` | Many-to-one relationships with materialized counts |
| `relations.*.field` | `"subject.uri"` | Field in the related record to match against |
| `relations.*.match` | `"uri"` | Match against parent's `"uri"` or `"did"` |
| `relations.*.groupBy` | — | Split counts by this field's value |
| `relations.*.groups` | — | Group value mappings (e.g. `{ going: "collection#going" }`) |
| `relations.*.count` | `true` | Enable materialized count columns on the parent |
| `references` | `{}` | Forward references to other collections for hydration |
| `references.*.collection` | — | Short name of the target collection (key in `collections`) |
| `references.*.field` | — | Field containing the target record's AT URI |
| `queries` | `{}` | Custom query handlers (raw Response) |
| `pipelineQueries` | `{}` | Custom query handlers that go through the standard filter/sort/hydration pipeline |
| `searchable` | disabled | Full-text search fields. SQLite uses FTS5 virtual tables; PostgreSQL uses tsvector generated columns with GIN indexes. Provide `string[]` to enable, omit to disable |
| `collection` | — | Full NSID of the record type this short-name entry indexes (required) |
| `methods` | `["listRecords", "getRecord"]` | XRPC methods to emit for this collection |
| `allowInSpaces` | `true` | When spaces are enabled, emit a parallel `spaces_records_<short>` table |

### Top-level options

| Option | Default | Description |
|--------|---------|-------------|
| `namespace` | — | Your reverse-domain namespace (e.g. `"com.example"`) |
| `collections` | — | Collection configurations |
| `profiles` | `["app.bsky.actor.profile"]` | Profile collection NSIDs |
| `relays` | Bluesky relays | Relay URLs for user discovery |
| `jetstreams` | Bluesky Jetstream | Jetstream URLs for real-time ingestion |
| `feeds` | — | Personalized feed configurations |
| `notify` | off | Expose `notifyOfUpdate`. `true` = open, string = `Authorization: Bearer <string>` required |
| `spaces` | — | Permissioned-spaces configuration. See [PERMISSIONED_DATA.md](./PERMISSIONED_DATA.md) |
| `logger` | `console` | Logger instance (`{ log, warn, error }`) |

### Profiles

`profiles` is a top-level config array of collection NSIDs that contain profile records (rkey `self`). Defaults to `["app.bsky.actor.profile"]`. These are auto-added to `collections` with `{ discover: false }`. Use `?profiles=true` on any endpoint to include a `profiles` map in the response, keyed by DID, with handle and profile record data.

## XRPC API

When using `createHandler`, all endpoints live under the deployment's own namespace at `/xrpc/{namespace}.{...}`:

| Endpoint | Description |
|----------|-------------|
| `{namespace}.{short}.listRecords` | List/filter records in a collection (keyed by its short name) |
| `{namespace}.{short}.getRecord` | Get single record by URI |
| `{namespace}.getProfile` | Get a user's profile by DID or handle |
| `{namespace}.notifyOfUpdate` | Notify of a record change for immediate indexing |
| `{namespace}.getCursor` | Current cursor position |
| `{namespace}.getOverview` | All collections summary |
| `{namespace}.permissionSet` | OAuth permission-set bundling every method above (auto-generated) |
| `{namespace}.space.*` | Spaces admin, invite, member, record XRPCs (when `spaces` is enabled) |

### Query parameters

**Filtering:**

| Param | Example | Description |
|-------|---------|-------------|
| `actor` | `?actor=did:plc:...` or `?actor=alice.bsky.social` | Filter by DID or handle (triggers on-demand backfill) |
| `profiles` | `?profiles=true` | Include profile + identity info keyed by DID |
| `search` | `?search=meetup` | Full-text search across searchable fields (FTS5, ranked) |
| `{field}` | `?status=going` | Equality filter on queryable string field |
| `{field}Min` | `?startsAtMin=2026-03-16` | Range minimum (datetime/integer fields) |
| `{field}Max` | `?endsAtMax=2026-04-01` | Range maximum (datetime/integer fields) |
| `{rel}CountMin` | `?rsvpsCountMin=10` | Minimum total relation count |
| `{rel}{Group}CountMin` | `?rsvpsGoingCountMin=10` | Minimum relation count for a specific groupBy value |
| `hydrate{Rel}` | `?hydrateRsvps=10` | Embed latest N related records (per group if grouped) |
| `hydrate{Ref}` | `?hydrateEvent=true` | Embed the referenced record |
| `sort` | `?sort=startsAt` | Sort by a queryable field or count (see below) |
| `order` | `?order=asc` | Sort direction: `asc` or `desc` (default depends on field type) |
| `limit` | `?limit=25` | Page size (1-200, default 50) |
| `cursor` | `?cursor=...` | Pagination cursor |

**Sorting** — `sort` accepts any queryable field param name or a count field:

```
?sort=startsAt                 # by date (default: desc for range fields)
?sort=name&order=asc           # by name ascending
?sort=rsvpsCount               # by total RSVP count (default: desc)
?sort=rsvpsGoingCount&order=asc  # by going count ascending
```

**Search** uses SQLite FTS5 or PostgreSQL tsvector for ranked full-text search. To enable, set `searchable: ["field1", "field2"]` on a collection. Supports FTS5 syntax including prefix (`meetup*`), phrases (`"rust meetup"`), and boolean (`rust OR typescript`). Combinable with all other filters.

```
?search=meetup                          # basic search
?search=meetup&mode=online              # search + filter
?search=rust*&sort=startsAt&order=asc   # search + sort override
```

**Hydration** embeds related or referenced records inline:

```
?hydrateRsvps=5              # latest 5 RSVPs per group (going, interested, etc.)
?hydrateEvent=true           # embed the referenced event record
?hydrateRsvps=5&hydrateEvent=true   # combine both
```

### Examples (events)

```
# Upcoming events with 10+ going RSVPs, with RSVP records and profiles
/xrpc/com.example.event.listRecords?startsAtMin=2026-03-16&rsvpsGoingCountMin=10&hydrateRsvps=5&profiles=true

# Events for a specific user (by handle)
/xrpc/com.example.event.listRecords?actor=alice.bsky.social&profiles=true

# Single event with counts, RSVPs, and profiles
/xrpc/com.example.event.getRecord?uri=at://did:plc:.../community.lexicon.calendar.event/...&hydrateRsvps=10&profiles=true

# Search for events by name/description
/xrpc/com.example.event.listRecords?search=meetup&profiles=true

# RSVPs for a specific event, with the referenced event embedded
/xrpc/com.example.rsvp.listRecords?subjectUri=at://did:plc:.../community.lexicon.calendar.event/...&hydrateEvent=true&profiles=true
```

## Notify of Updates

By default, Contrail ingests from Jetstream every minute (in the Worker example). If your app writes to a user's PDS and needs the change reflected immediately, use `contrail.notify()` or call the XRPC endpoint:

```ts
// Programmatic
await contrail.notify(uri);

// Or via HTTP
await fetch("https://your-contrail.workers.dev/xrpc/com.example.notifyOfUpdate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ uri }),
});
```

Contrail fetches the record from the user's PDS and figures out what to do:

| PDS returns | Already indexed? | Action |
|---|---|---|
| Record (new CID) | No | **Create** — indexes it, recounts relations |
| Record (new CID) | Yes | **Update** — upserts the record, recounts relations |
| Record (same CID) | Yes | **Skip** — nothing changed |
| 404 | Yes | **Delete** — removes it, recounts relations |
| 404 | No | **No-op** |

When Jetstream later delivers the same event, the duplicate is detected by CID and skipped.

## Permissioned Data

Contrail ships an opt-in permissioned-spaces subsystem: an auth-gated store for records that can't live on public PDSes — private events, invite-only groups, members-only chat. Set `config.spaces` and contrail exposes the space XRPCs at `{namespace}.space.*` alongside your public indexer:

```ts
const contrail = new Contrail({
  namespace: "com.example",
  collections: { /* ... */ },
  spaces: {
    type: "com.example.event.space",   // NSID classifying the kind of space
    serviceDid: "did:web:example.com", // your deployment's DID
    // `resolver` is optional — defaults to a composite did:plc + did:web resolver.
  },
});
```

Each collection you declare also gets a parallel `spaces_records_<short>` table (opt out per-collection via `allowInSpaces: false`). Auth uses atproto service-auth JWTs via `@atcute/xrpc-server`. Access is a simple `read` / `write` permission per member — the space owner is implicit write. Invites are first-class (generated token, hashed-at-rest, expiry + max-uses + revocation).

**Unified `listRecords`.** The per-collection `listRecords` endpoint accepts three call shapes:

| Call | Returns |
| --- | --- |
| No auth, no `spaceUri` | Public records only |
| `?spaceUri=…` + service-auth JWT | Records from that one space (ACL-gated) |
| Service-auth JWT, no `spaceUri` | Public records **unioned** with records from every space the caller is a member of |

The union path runs the public and per-space queries in parallel and merges with a shared keyset cursor, so filters, sorts (`time`, record-field, count), hydration, and references all work across sources. Records from a space carry a `space: <spaceUri>` field in the response.

Full design, migration story, and known limits: [PERMISSIONED_DATA.md](./PERMISSIONED_DATA.md).

## Typesafe Client Usage

You can get fully typed XRPC queries for any Contrail instance using [`@atcute/lex-cli`](https://github.com/mary-ext/atcute). The lexicon files are committed to the repo, so you can pull them directly via the git source.

### Setup

```bash
npm install @atcute/client @atcute/lexicons @atcute/lex-cli
```

Create a `lex.config.js` pointing at the Contrail instance's repo:

```js
import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  outdir: "src/lexicon-types/",
  imports: ["@atcute/atproto"],
  files: ["lexicons/**/*.json"],
  pull: {
    outdir: "lexicons/",
    sources: [
      {
        type: "git",
        remote: "https://github.com/USER/REPO.git", // the Contrail instance repo
        pattern: ["lexicons-generated/**/*.json", "lexicons-pulled/**/*.json", "lexicons/**/*.json"],
      },
    ],
  },
});
```

Then pull and generate:

```bash
npx lex-cli pull && npx lex-cli generate
```

### Usage

Import the generated types (side-effect import registers them with `@atcute/client`), then query with full type safety:

```ts
import "./lexicon-types/index.js"; // registers ambient types
import { Client } from "@atcute/client";

const rpc = new Client({ handler: simpleFetchHandler({ service: /* your contrail url */ }) });

const response = await rpc.get("com.example.rsvp.listRecords", {
  params: { status: "going", limit: 10 }, // typed params
});

if (response.ok) {
  console.log(response.data.records); // typed
}
```
