# Configure and query

Each entry in `collections` becomes typed `getRecord` and `listRecords` methods. Declare only the fields and relationships your app needs:

```ts
// contrail.config.ts
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
};
```

This produces the following client parameters:

| Config | Query parameter |
|---|---|
| `mode: {}` | `mode` |
| `startsAt: { type: "range" }` | `startsAtMin`, `startsAtMax` |
| `searchable` | `search` |
| `relations.rsvps` | `rsvpsCountMin`, `hydrateRsvps` |
| `groups.going` | `rsvpsGoingCountMin` |
| `references.event` | `hydrateEvent` |

Dotted fields become camel case: `subject.uri` becomes `subjectUri`. Every list method also supports `actor` (a DID or handle), `sort`, `order`, `limit`, `cursor`, and `profiles`.

Equality fields get a composite index on `(field, time_us DESC, uri ASC)` for the common filtered list in default chronological order. Range fields retain a single-field index; multiple filters, other sorts and dense timestamp ties can require additional candidate reads. The equality index also serves relation/follow lookups on that field, so Contrail does not retain a redundant single-field index. Feeds additionally index record URIs to avoid scanning unrelated feed entries when deleting a record.

With an unchanged app config, upgrading from the preceding schema installs these indexes without rebuilding FTS or resetting records/cursors. Index construction still incurs one-time database work; the extra feed URI index also adds ongoing writes per feed entry.

A reference hydrates the current indexed target record identified by the URI in
`field`. If that field comes from a strongRef, Contrail does not retrieve the
historical record version named by the strongRef's CID. Lexicons also do not
usually identify a reference's target collection or desired inverse relation;
configure those semantics explicitly. Prefix initialization prompts for these
choices on a TTY and otherwise leaves them unconfigured.

## Repository-scoped collections

Use `repos` to index a collection from an explicit set of publishing repositories:

```ts
collections: {
  event: {
    collection: "community.lexicon.calendar.event",
  },
  listItem: {
    collection: "app.bsky.graph.listitem",
    repos: ["did:plc:yourbot"],
    queryable: { list: {}, subject: {} },
  },
}
```

There are three acquisition modes:

| Config | Historical acquisition and live admission |
|---|---|
| Default | Discover repositories and admit their records. `app.bsky.*` collections default to `discover: false` instead. |
| `discover: false` | Acquire dependent records from already-known repositories. |
| `repos: [did, …]` | Backfill only these repository/collection pairs and admit only these publishers, without requiring prior discovery. |

`repos` is an exclusive publisher allowlist, not a seed list. It requires a
non-empty array of unique DIDs; handles and combining it with `discover` are
rejected. A record referencing the bot's list is not enough: its publisher must
also be allowed. Body-level `recordFilter` predicates still apply.

Initialization queues the configured pairs in the existing backfill worklist.
Run backfill or scheduled retries to load their history; normal ingestion keeps
them current. Scope does not relay-discover this collection or enroll relay
actors in it, and does not enqueue other dependent collections for these DIDs.
Backfill progress, completion and retry state use the existing status tooling.
Notify and actor read-through enforce the same scope before fetching records.
Other sources, including snapshot/bootstrap imports, share canonical admission.

The scope is durable projection policy. Reordering the same DIDs is harmless,
and new empty scoped collections can be added to an existing AppView. Changing
or removing an existing allowlist, or applying one to a populated unrestricted
collection, requires rebuilding the projection database; initialization rejects
these changes rather than leaving stale rows or incomplete history. Temporarily
omitting a collection does not erase its registered scope.

This bounds acquisition and persistence, not necessarily transport bandwidth:
a shared Jetstream subscription can still receive other publishers' records
before filtering. It also does not provide read-your-writes or certify a fresh,
complete reconciliation source. Applications that mutate records based on the
projection must separately handle initial backfill, indexing lag and recovery.

## Query from the client

After changing the config, re-run `contrail connect` in your app. The generated Atcute client now knows the new parameters and response types:

```ts
const response = await contrail.get("com.example.event.listRecords", {
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

if (!response.ok) throw new Error(`Contrail returned ${response.status}`);

const { records, profiles, cursor } = response.data;
```

Every record has `uri`, `cid`, and its original record body in `value`. Hydrated relations and references are added to that record; requested profiles are returned once in the top-level `profiles` array.

Pass the returned opaque `cursor` into the same query to get the next page. `limit` defaults to 50 and may be 1–200.

Full-text `search` works with D1 and PostgreSQL. The zero-config local SQLite AppView does not provide full-text search.

## Lexicon source files

Contrail resolves checked-in Lexicon documents in this order:

1. `lexicons/custom/` — application-owned schemas;
2. `lexicons/pinned/` — verified, CID-pinned schemas created by prefix
   initialization; and
3. `lexicons/pulled/` — mutable schemas fetched by `contrail lexicons all`.

The first document for an NSID wins. Remote pull generation does not request an
NSID already supplied by `custom` or `pinned`, and cleaning pulled output does
not replace either directory. Keep `lexicons/pinned.lock` with the pinned files;
it records the registry snapshot, verification state, source CID, authority,
and role of each imported document.
