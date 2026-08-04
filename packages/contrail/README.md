# `@atmo-dev/contrail`

> Pre-alpha. Expect breaking changes.

One package for indexing and querying public AT Protocol records.

## Basic use

```ts
import { Contrail } from "@atmo-dev/contrail";

const contrail = new Contrail({
  namespace: "com.example",
  db,
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
          field: "subject.uri",
          groupBy: "status",
          groups: {
            going: "community.lexicon.calendar.rsvp#going",
          },
        },
      },
    },
    rsvp: {
      collection: "community.lexicon.calendar.rsvp",
      references: {
        event: { collection: "event", field: "subject.uri" },
      },
    },
  },
});

await contrail.init();
await contrail.backfillAll({ concurrency: 100 });
```

## Query

```ts
const result = await contrail.query("event", {
  filters: { mode: "in-person" },
  sort: { countType: "rsvp", direction: "desc" },
  limit: 20,
});
```

HTTP routes expose the same pipeline, including relationship/reference hydration, counts, profiles, search, and custom queries.

## Keep records current

```ts
await contrail.ingest(); // bounded Jetstream cycle

await contrail.runPersistent({
  signal: abortController.signal,
  batchSize: 50,
  flushIntervalMs: 5_000,
});
```

After a write to a user's PDS, `contrail.notify(uri)` can fetch the authoritative record immediately. Only an authoritative not-found response deletes local state; rate limits, server errors, timeouts, malformed responses, and network failures leave it unchanged. Authentication and abuse controls for the public HTTP operation remain under design.

## HTTP

```ts
import { createHandler } from "@atmo-dev/contrail/server";

const handle = createHandler(contrail);
const response = await handle(request, db);
```

For Workers, use `createWorker` from `@atmo-dev/contrail/worker`.

## Adapters

```ts
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
```

The SQLite adapter uses the built-in `node:sqlite` module and therefore requires Node.js 22.13 or newer. D1 implements Contrail's database interface directly.
