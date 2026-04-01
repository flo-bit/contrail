# Contrail

> [!WARNING]
> Work in progress! Pre-alpha, expect breaking changes.

A library for indexing AT Protocol records. Define collections — get automatic Jetstream ingestion, PDS backfill, user discovery, and typed XRPC endpoints. Works with Cloudflare Workers + D1, SvelteKit, Node.js, or any JavaScript runtime.

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
    "community.lexicon.calendar.event": {
      queryable: {
        mode: {},                        // string → equality filter (?mode=online)
        name: {},                        // string → equality filter (?name=...)
        startsAt: { type: "range" },     // range → min/max filters (?startsAtMin=...&startsAtMax=...)
        endsAt: { type: "range" },
      },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
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
    "community.lexicon.calendar.rsvp": {
      queryable: {
        status: {},
        "subject.uri": {},
      },
      references: {
        event: {
          collection: "community.lexicon.calendar.event",
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
  "community.lexicon.calendar.event",
  {
    filters: { mode: "in-person" },
    sort: { countType: "community.lexicon.calendar.rsvp", direction: "desc" },
    limit: 20,
  }
);
```

### Ingest from Jetstream

```ts
// Run one ingestion cycle (catches up to present, then stops)
await contrail.ingest();
```

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
import { SqliteDatabase } from "@atmo-dev/contrail/sqlite";
import Database from "better-sqlite3";

const db = new SqliteDatabase(new Database("data.db"));
const contrail = new Contrail({ ...config, db });
```

## Running the example (Cloudflare Workers)

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
| `references.*.collection` | — | Target collection NSID |
| `references.*.field` | — | Field containing the target record's AT URI |
| `queries` | `{}` | Custom query handlers (raw Response) |
| `pipelineQueries` | `{}` | Custom query handlers that go through the standard filter/sort/hydration pipeline |
| `searchable` | disabled | FTS5 search fields. Provide `string[]` to enable, omit to disable |

### Top-level options

| Option | Default | Description |
|--------|---------|-------------|
| `namespace` | — | Your reverse-domain namespace (e.g. `"com.example"`) |
| `collections` | — | Collection configurations |
| `profiles` | `["app.bsky.actor.profile"]` | Profile collection NSIDs |
| `relays` | Bluesky relays | Relay URLs for user discovery |
| `jetstreams` | Bluesky Jetstream | Jetstream URLs for real-time ingestion |
| `feeds` | — | Personalized feed configurations |
| `logger` | `console` | Logger instance (`{ log, warn, error }`) |

### Profiles

`profiles` is a top-level config array of collection NSIDs that contain profile records (rkey `self`). Defaults to `["app.bsky.actor.profile"]`. These are auto-added to `collections` with `{ discover: false }`. Use `?profiles=true` on any endpoint to include a `profiles` map in the response, keyed by DID, with handle and profile record data.

## XRPC API

When using `createHandler`, all endpoints are available at `/xrpc/{nsid}.{method}`:

| Endpoint | Description |
|----------|-------------|
| `{collection}.listRecords` | List/filter records |
| `{collection}.getRecord` | Get single record by URI |
| `{namespace}.getProfile` | Get a user's profile by DID or handle |
| `{namespace}.notifyOfUpdate` | Notify of a record change for immediate indexing |
| `{namespace}.getCursor` | Current cursor position |
| `{namespace}.getOverview` | All collections summary |

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

**Search** uses SQLite FTS5 for ranked full-text search. To enable, set `searchable: ["field1", "field2"]` on a collection. Supports FTS5 syntax including prefix (`meetup*`), phrases (`"rust meetup"`), and boolean (`rust OR typescript`). Combinable with all other filters.

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
/xrpc/community.lexicon.calendar.event.listRecords?startsAtMin=2026-03-16&rsvpsGoingCountMin=10&hydrateRsvps=5&profiles=true

# Events for a specific user (by handle)
/xrpc/community.lexicon.calendar.event.listRecords?actor=alice.bsky.social&profiles=true

# Single event with counts, RSVPs, and profiles
/xrpc/community.lexicon.calendar.event.getRecord?uri=at://did:plc:.../community.lexicon.calendar.event/...&hydrateRsvps=10&profiles=true

# Search for events by name/description
/xrpc/community.lexicon.calendar.event.listRecords?search=meetup&profiles=true

# RSVPs for a specific event, with the referenced event embedded
/xrpc/community.lexicon.calendar.rsvp.listRecords?subjectUri=at://did:plc:.../community.lexicon.calendar.event/...&hydrateEvent=true&profiles=true
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

const response = await rpc.get("community.lexicon.calendar.event.getRecords", {
  params: { status: "going", limit: 10 }, // typed params
});

if (response.ok) {
  console.log(response.data.records); // typed
}
```
