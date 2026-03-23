# Contrail

> [!WARNING]
> Work in progress! Pre-alpha, expect breaking changes.

Define collections — get automatic Jetstream ingestion, PDS backfill, user discovery, and typed XRPC endpoints. Runs on Cloudflare Workers + D1.

## Quickstart

## Config

Edit `src/config.ts` — this is the only file you need to touch:

```ts
export const config: ContrailConfig = {
  namespace: "com.example",            // your reverse-domain namespace
  collections: {
    "community.lexicon.calendar.event": {
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",      // materialized counts by status
        },
      },
    },
    "community.lexicon.calendar.rsvp": {},
  }
};
```

### Dev

```bash
pnpm install
pnpm generate:pull   # pull lexicons from network, auto-detect fields, generate types
pnpm sync            # discover users and backfill records from PDS
pnpm dev:auto        # start wrangler dev with auto-ingestion
```

### Production

```bash
npx wrangler d1 create contrail
# Add database_id to wrangler.toml
pnpm deploy
# to sync in production, run it locally but set your d1 to remote, then run
pnpm sync
```

Ingestion runs automatically via cron (`*/1 * * * *`). Schema is auto-initialized.


### What's auto-detected from lexicons

When you run `pnpm generate`, queryable fields are derived from each collection's lexicon:

- **String fields** → equality filter (`?status=going`)
- **Datetime/integer fields** → range filters (`?startsAtMin=2026-03-16&startsAtMax=2026-04-01`)
- **StrongRef fields** → `.uri` equality filter (`?subjectUri=at://...`)

You can override any auto-detected field by specifying `queryable` manually in config.

### Collection options

| Option | Default | Description |
|--------|---------|-------------|
| `queryable` | auto-detected | Override auto-detected queryable fields |
| `discover` | `true` | Find users via relays. `false` = only track known DIDs |
| `relations` | `{}` | Many-to-one relationships with materialized counts |
| `relations.*.field` | `"subject.uri"` | Field in the related record to match against |
| `relations.*.match` | `"uri"` | Match against parent's `"uri"` or `"did"` |
| `relations.*.groupBy` | — | Split counts by this field's value |
| `queries` | `{}` | Custom query handlers |
| `searchable` | auto-detected | FTS5 search fields. `string[]` = explicit fields, `false` = disabled, omitted = all non-range queryable fields |

### Profiles

`profiles` is a top-level config array of collection NSIDs that contain profile records (rkey `self`). Defaults to `["app.bsky.actor.profile"]`. These are auto-added to `collections` with `{ discover: false }`. Use `?profiles=true` on any endpoint to include a `profiles` map in the response, keyed by DID, with handle and profile record data.

## API

All endpoints at `/xrpc/{nsid}.{method}`:

| Endpoint | Description |
|----------|-------------|
| `{collection}.listRecords` | List/filter records |
| `{collection}.getRecord` | Get single record by URI |
| `{namespace}.getProfile` | Get a user's profile by DID or handle |
| `{namespace}.notifyOfUpdate` | Notify of a record change for immediate indexing |
| `{namespace}.admin.sync` | Discover + backfill (requires `ADMIN_SECRET`) |
| `{namespace}.admin.getCursor` | Current cursor position |
| `{namespace}.admin.getOverview` | All collections summary |
| `{namespace}.admin.reset` | Delete all data (requires `ADMIN_SECRET`) |

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
| `limit` | `?limit=25` | Page size (1-100, default 50) |
| `cursor` | `?cursor=...` | Pagination cursor |

**Sorting** — `sort` accepts any queryable field param name or a count field:

```
?sort=startsAt                 # by date (default: desc for range fields)
?sort=name&order=asc           # by name ascending
?sort=rsvpsCount               # by total RSVP count (default: desc)
?sort=rsvpsGoingCount&order=asc  # by going count ascending
```

**Search** uses SQLite FTS5 for ranked full-text search. By default, all non-range queryable fields are searchable. Results are ranked by relevance (BM25) with `time_us` as tiebreaker. Supports FTS5 syntax including prefix (`meetup*`), phrases (`"rust meetup"`), and boolean (`rust OR typescript`). Combinable with all other filters.

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

By default, Contrail ingests from Jetstream every minute. If your app writes to a user's PDS and needs the change reflected immediately, call `notifyOfUpdate` right after the write:

```ts
// User creates an RSVP via their PDS
const { uri } = await agent.createRecord({ ... });

// Tell Contrail to fetch and index it now
await fetch("https://your-contrail.workers.dev/xrpc/com.example.notifyOfUpdate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ uri }),
});
```

Contrail fetches the record from the user's PDS and figures out what to do:

| PDS returns | Already indexed? | Action |
|---|---|---|
| Record (new CID) | No | **Create** — indexes it, updates relation counts |
| Record (new CID) | Yes | **Update** — upserts the record |
| Record (same CID) | Yes | **Skip** — nothing changed |
| 404 | Yes | **Delete** — removes it, decrements counts |
| 404 | No | **No-op** |

You can also batch up to 25 URIs in one request:

```ts
await fetch(".../xrpc/com.example.notifyOfUpdate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ uris: [uri1, uri2, uri3] }),
});
```

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
