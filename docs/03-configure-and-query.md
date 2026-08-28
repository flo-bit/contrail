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

Next: [deploy to Cloudflare Workers](./03-deploy-cloudflare.md).
