# Configure and query

Each entry in `collections` generates typed `getRecord` and `listRecords` XRPC methods.

```ts
// contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export default {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
        startsAt: { type: "range" },
      },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "rsvp",
          groupBy: "status",
          groups: {
            going: "community.lexicon.calendar.rsvp#going",
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
        event: { collection: "event", field: "subject.uri" },
      },
    },
  },
} satisfies ContrailConfig;
```

## Generated parameters

| Config | Query parameter | Notes |
| --- | --- | --- |
| `queryable: { mode: {} }` | `mode` | Exact match; indexed on `(field, time_us DESC, uri ASC)` |
| `queryable: { startsAt: { type: "range" } }` | `startsAtMin`, `startsAtMax` | Single-field range index |
| `searchable: ["name", ...]` | `search` | Full-text search (D1, PostgreSQL, SQLite with FTS5) |
| `relations.rsvps` | `rsvpsCountMin`, `hydrateRsvps` | Counts and hydrates child records pointing at this record |
| `groups.going` | `rsvpsGoingCountMin` | Count filter for one grouped relation value |
| `references.event` | `hydrateEvent` | Hydrates the current indexed target record at `field` (not historical strongRef CIDs) |

Dotted field paths become camelCase (`subject.uri` → `subjectUri`). Every `listRecords` method also supports `actor` (DID or handle), `sort`, `order`, `limit` (1–200, default 50), `cursor`, and `profiles`.

## Querying

```ts
const res = await contrail.get("com.example.event.listRecords", {
  params: {
    mode: "in-person",
    startsAtMin: new Date().toISOString(),
    rsvpsGoingCountMin: 5,
    sort: "startsAt",
    order: "asc",
    hydrateRsvps: 3,
    profiles: true,
    limit: 20,
  },
});

if (!res.ok) throw new Error(`Contrail returned ${res.status}`);
const { records, profiles, cursor } = res.data;
```

Each item in `records` has `uri`, `cid`, `value` (the raw record body), plus any hydrated relations/references. Profiles are deduplicated in the top-level `profiles` array. Pass `cursor` back to fetch the next page.

## Collection options

| Option | Behavior |
| --- | --- |
| *(default)* | Relay-discover repositories and admit their records (`app.bsky.*` defaults to `discover: false`) |
| `discover: false` | Index only for already-known repositories |
| `repos: ["did:plc:..."]` | Exclusive publisher allowlist (non-empty unique DIDs; cannot combine with `discover`). Changing or removing a scope later requires rebuilding the database. |
| `recordFilter: (rec) => boolean` | Drop non-matching records on ingest. Set `recordFilterTombstones: false` to avoid storing tombstones for never-indexed records. |
| `validate: true` | Validate incoming records against your bundled Lexicons before indexing |
| `timeField` | Record field used for default chronological ordering (defaults to `"createdAt"`, or `false` to use ingest time) |

## Profiles & custom queries

- `profiles`: defaults to `["app.bsky.actor.profile"]`. Pass `[]` to disable profile hydration or pass custom profile NSIDs.
- `queries`: register custom read-only XRPC queries with `pipeline` (filters/hydration) or raw SQL handlers. In raw SQL, filter with `visibleRecordSql(alias)` to enforce moderation.

## Lexicon resolution order

Checked-in Lexicons resolve in this order (first match wins):

1. `lexicons/custom/` — hand-edited schemas
2. `lexicons/pinned/` — CID-pinned schemas from `contrail init --prefix` (keep `lexicons/pinned.lock`)
3. `lexicons/pulled/` — schemas fetched by `contrail lexicons all`

Next: [Deploy to Cloudflare Workers & Node](./04-deploy-cloudflare.md).
