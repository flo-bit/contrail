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

## Fresh generations (experimental)

`PdsSnapshotSource`, `JetstreamChangeSource`, `DatabaseBootstrapTarget`, and `bootstrapFreshProjection()` build an unpublished database with capture-first replay. The capture mark is durable before relay discovery starts; PDS partition cursors and Jetstream checkpoints commit with their records. Completion rebuilds deferred projections, verifies aggregate record/version consistency, and stores only bounded failure categories.

Jetstream generation replay requires an operator-owned continuity epoch and retention guarantee. It uses real stream events as marks, never wall clock or a quiet socket. Optional busy watermark collections can prove progress without being projected.

A separate control database can use `DatabaseGenerationRegistry` to store immutable `(code, definition, database, generation)` tuples. `activate(candidate, expectedActive)` switches one singleton pointer with compare-and-swap, retaining the previous ready tuple for rollback. There is intentionally no percentage traffic-split API; platform routing must resolve the one active tuple.

## Generate Lexicons

Generate XRPC query Lexicons from the Contrail config and check them for drift:

```bash
pnpm contrail lexicons generate
pnpm contrail lexicons check
```

`contrail lexicons all` also pulls referenced record Lexicons and runs Atcute TypeScript generation. Use `--public` when generating only methods advertised by the remote service contract, including explicitly protected service-auth methods. Generated `lex.config.js` files carry an ownership marker; existing user-owned Atcute configuration is never replaced. Pass `--no-atcute-config` to manage that file yourself. The generator is also exported from `@atmo-dev/contrail/lexicons` for programmatic use.

## Public read-through service

```ts
export default createWorker(config, {
  lexicons,
  publicService: { endpoint: "https://api.example.com" },
});
```

Discovery at `/.well-known/contrail` advertises a canonical contract digest and a content-addressed Lexicon bundle. Anonymous collection reads, profiles, feeds, and authored custom queries may acquire public AT Protocol data and improve the cache behind the response.

Personalized feeds and `notifyOfUpdate` can instead require method-bound AT Protocol service tokens:

```ts
const config = {
  notify: true,
  serviceAuth: {
    audience: "did:web:api.example.com",
    methods: ["getFeed", "notifyOfUpdate"],
  },
  // ...
};
```

The protected contract advertises the audience and each query/procedure separately from anonymous methods. `contrail connect` generates `src/contrail/index.ts`; the module pins the discovered contract digest and verifies it once at runtime before sending provider requests. Its exported `contrail.scope` is the provider's verified OAuth permission, such as `rpc?lxm=*&aud=did:web:api.example.com`. `contrail.authenticated(authenticatedClient)` returns one Atcute client: advertised provider methods route to Contrail, ordinary methods route to the PDS, and successful tracked `createRecord`, `putRecord`, and `deleteRecord` calls automatically notify Contrail. Handle-form deletes are resolved to canonical DID URIs. Protected methods use cached exact method-bound tokens, while transient discovery failures remain retryable. Feed actors must resolve to the token issuer, and every notified AT URI must belong to the issuer. When the audience matches the public endpoint's `did:web`, the Worker publishes its service document at `/.well-known/did.json`.

Public-service mode requires a primary ordered source so `getCursor` can expose its committed position. Existing non-public deployments without one retain the legacy ingestion-time cursor response:

```ts
const config = {
  orderedSource: {
    source: "jetstream",
    epoch: "primary-2026", // change whenever cursor continuity changes
  },
  // ...
};
```

The returned cursor is opaque. Compare the complete `{ source, epoch, cursor }` value for equality; never order cursors from different epochs. Consumers can read the position before and after a query, retry if it changed, then poll it as a refetch/invalidation signal.

Connect an independent consumer with `contrail connect <https-origin>`. A repeated connection to the same endpoint and provider-owned output root requires `--update`; provider files and the lock are staged and swapped without deleting consumer-owned Lexicons. Switching providers or output roots requires removing the existing connection deliberately, so stale Lexicons cannot remain under a broad generator glob.

See [Creating a public service](../../docs/public-services/creating.md), [Using a public service](../../docs/public-services/using.md), and [Example: api.atmo.rsvp](../../docs/public-services/api-atmo-rsvp.md) for complete provider and consumer walkthroughs.

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
