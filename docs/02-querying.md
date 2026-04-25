# Querying

Once [indexing](./01-indexing.md) is set up, every collection you declared gets a pair of XRPC endpoints under `/xrpc/{namespace}.{short}.*`:

| Endpoint | Returns |
|---|---|
| `{namespace}.{short}.listRecords` | Paginated list with filters, sorts, hydration |
| `{namespace}.{short}.getRecord?uri=…` | Single record by AT-URI |

Plus a few top-level ones: `{namespace}.getProfile`, `{namespace}.getCursor`, `{namespace}.getOverview`, `{namespace}.notifyOfUpdate`, `{namespace}.permissionSet`, `{namespace}.lexicons`.

## HTTP (what most callers use)

Every config field becomes a predictable URL param:

```
/xrpc/com.example.event.listRecords?mode=online&startsAtMin=2026-01-01&rsvpsGoingCountMin=10&sort=startsAt&order=asc&hydrateRsvps=5
/xrpc/com.example.event.getRecord?uri=at://did:plc:.../...&hydrateRsvps=5
```

| Config produces | URL param |
|---|---|
| `queryable: { field: {} }` | `?field=value` (equality) |
| `queryable: { field: { type: "range" } }` | `?fieldMin=…`, `?fieldMax=…` |
| `relations: { rel: {...} }` | `?relCountMin=N`, `?sort=relCount`, `?hydrateRel=N` |
| `relations: { rel: { groups: { going } } }` | `?relGoingCountMin=N`, `?sort=relGoingCount` |
| `references: { ref: {...} }` | `?hydrateRef=true` |

Dotted field names become camelCase params — `queryable: { "subject.uri": {} }` → `?subjectUri=…`.

## Programmatic

```ts
const { records, cursor } = await contrail.query("event", {
  filters: { mode: "online" },
  rangeFilters: { startsAt: { min: "2026-01-01" } },
  countFilters: { rsvp: 10 },                         // keyed by child collection short name
  sort: { recordField: "startsAt", direction: "asc" },
  limit: 20,
});
```

The programmatic shape doesn't use the URL param names — keys are the underlying field/collection identifiers:

- `filters` / `rangeFilters` — keyed by the field name from your config (`startsAt`, `subject.uri`), not the camelCased URL param.
- `countFilters` — keyed by the target collection's short name for totals, or by the full `nsid#group` token for group counts. E.g., `{ rsvp: 10 }` for "at least 10 RSVPs total," or `{ "community.lexicon.calendar.rsvp#going": 10 }` for "at least 10 going."
- `sort` — `{ recordField, direction }` for field sorts, `{ countType, direction }` for count sorts (where `countType` is the same collection-short-name or `nsid#group` as above).

For count filters / sorts, the HTTP side is nicer than the programmatic side — consider going through `createHandler` + `fetch` even for in-process calls if you want the friendly names. Or use `createServerClient` from `@atmo-dev/contrail/server` for a typed XRPC client that runs in-process (no fetch roundtrip).

## Pagination

```
?limit=25&cursor=<opaque>
```

`cursor` is opaque — pass back whatever `listRecords` returned in its `cursor` field. `limit` is 1–200 (default 50). Cursors embed the sort kind, so a cursor from a `sort=startsAt` query is ignored by a `sort=rsvpsCount` query instead of silently returning wrong results.

```ts
let cursor: string | undefined;
do {
  const page = await contrail.query("event", { limit: 100, cursor });
  // process page.records
  cursor = page.cursor;
} while (cursor);
```

## Hydration

Each record response is a flat shape:

```jsonc
{
  "uri": "at://did:plc:.../community.lexicon.calendar.event/...",
  "cid": "...",
  "value": { "name": "Rust meetup", "startsAt": "2026-03-16T...", ... },
  "rsvpsCount": 42,        // from relations
  "rsvpsGoingCount": 30,
  // relations + references appear here only when hydrated
}
```

The `value` field carries the record body — same shape as atproto's `com.atproto.repo.listRecords#record`. `did`, `collection`, `rkey`, and `time_us` are also returned alongside as optional extras.

### `?hydrateRel=N` (relations)

Embeds the latest N child records per group, inline under the parent:

```
/xrpc/com.example.event.listRecords?hydrateRsvps=5
```

Returns:

```jsonc
{
  "records": [{
    "uri": "at://.../event/...",
    "value": { "name": "..." },
    "rsvpsCount": 42,
    "rsvps": {
      "going":     [ {uri, cid, value}, ... 5 items ],
      "interested":[ {uri, cid, value}, ... 5 items ]
    }
  }]
}
```

Max 50 per group. For grouped relations you get one array per group value; for ungrouped relations just a flat array.

### `?hydrateRef=true` (references)

Embeds the single referenced parent record — useful for RSVP lists that need to show event details:

```
/xrpc/com.example.rsvp.listRecords?subjectUri=at://.../event/...&hydrateEvent=true
```

Each RSVP record in the response gains an `event: {uri, cid, value}` field.

### `?profiles=true`

Opt in to profile + handle hydration for every DID referenced in the result:

```
/xrpc/com.example.event.listRecords?profiles=true
```

Response grows a top-level `profiles` array, one entry per (DID, configured profile NSID):

```jsonc
{
  "records": [...],
  "profiles": [
    {
      "did": "did:plc:alice...",
      "handle": "alice.bsky.social",
      "uri": "at://did:plc:alice.../app.bsky.actor.profile/self",
      "cid": "...",
      "collection": "app.bsky.actor.profile",
      "rkey": "self",
      "value": { /* profile record body */ }
    }
  ]
}
```

A DID with no profile record (or whose handle resolved but profile didn't) shows up as a bare `{ did, handle }` entry — `uri`/`cid`/`value` are omitted. With multiple profile NSIDs configured, you'll see one entry per (DID × NSID) that resolved.

Which profile NSID(s) to hydrate from is configured at the top level of Contrail's config (`profiles`, defaults to `["app.bsky.actor.profile"]`).

## Full-text search

```
?search=meetup
?search=meetup*
?search="rust meetup"
?search=rust OR typescript
```

Combinable with every other filter and sort. Backed by SQLite FTS5 (D1) or Postgres tsvector (Postgres adapter). Not available on `node:sqlite` — that adapter doesn't ship FTS5.

When searching, results are ranked by relevance by default. Override with an explicit `sort` param.

## Examples

```
# Upcoming events with 10+ going RSVPs, with RSVP records + profiles
?startsAtMin=2026-03-16&rsvpsGoingCountMin=10&hydrateRsvps=5&profiles=true

# Events for a specific user (by handle — triggers on-demand backfill)
?actor=alice.bsky.social&profiles=true

# RSVPs for one event, with the event record embedded
?subjectUri=at://did:plc:.../event/...&hydrateEvent=true&profiles=true

# Search + filter + sort
?search=meetup&mode=online&sort=startsAt&order=asc
```
