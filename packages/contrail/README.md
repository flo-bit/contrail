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

Contrail stores source event time, repository revision, source cursor, CID, and local index time separately from record/application time. Durable tombstones reject stale resurrection, and live Jetstream projection commits its exact yielded cursor in the same transaction. A successful PDS `listRecords` page is a current authoritative observation, so it supersedes older durable state without a redundant version read; its version writes and page cursor still commit atomically. Tombstones are retained indefinitely; authoritative rebuild/retention tooling is planned separately.

## Runtime record validation

Pass the record Lexicons for every configured collection and their transitive references to enable shared strict validation and CID verification:

```ts
const contrail = new Contrail({
  db,
  namespace: "com.example",
  collections,
  validation: {
    lexicons: [eventLexicon, profileLexicon, strongRefLexicon],
    strict: true,      // default: enforce blob size/MIME constraints too
    verifyCid: true,   // default: canonical DAG-CBOR CID verification
  },
});
```

Validation is opt-in for compatibility, but once configured it applies identically to Jetstream, PDS backfill, notify, on-demand profiles, Constellation enrichment, and direct `ingestRecords()` calls. Configuration fails early when a collection or referenced Lexicon is missing. Authoritative sources must provide matching CIDs; local and Constellation synthetic records may be CID-less by default. Override `allowCidlessSources` only for explicitly trusted synthetic adapters.

`createWorker(config, { lexicons })` continues to expose method Lexicons over HTTP; it does not silently enable record validation. Put record schemas in `config.validation.lexicons` deliberately.

Private aggregate-only rejection counters are available without exposing DIDs, URIs, errors, or record bodies. Concurrent bulk backfill accumulates these bounded counters in memory and flushes once per run, so diagnostics cannot turn into a hot D1 row on every source page:

```ts
const diagnostics = await contrail.diagnostics();
```

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
