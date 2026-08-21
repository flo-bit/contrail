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

Projection winner selection is guarded again inside the write transaction. Overlapping cron, persistent, notify, or backfill writers cannot commit a stale canonical row, derived projection, tombstone, or source checkpoint; a changed predecessor rolls the complete attempt back and retries from fresh durable state.

## Transactional change log (experimental)

Fresh empty generations may opt into a compact transactional projection change log:

```ts
const config = {
  // ...
  changes: {
    consumers: {
      search: {
        collections: ["community.lexicon.calendar.event"],
        phases: ["historical", "live"],
        initial: "current",
        requiredForActivation: true,
      },
    },
  },
} satisfies ContrailConfig;
```

Static definitions contain no handlers, URLs, clients, credentials, or secrets. Contrail registers them with a random database-generation ID and collection/phase coverage ledger. A winning logical put/delete appends one compact URI/version reference in the same transaction as canonical and derived state plus the source checkpoint. Duplicate, stale, same-CID, absent-delete, rejected, and rolled-back mutations append nothing. Record bodies are hydrated from current state by the later delivery layer rather than copied into the log.

Low-level delivery uses bounded leases and compare-and-swap acknowledgement:

```ts
const claim = await contrail.changes.claim("webhooks", {
  maxBatches: 20,
  maxChanges: 500,
  maxBytes: 512_000,
  leaseMs: 30_000,
});
if (claim) {
  try {
    const batch = await contrail.changes.hydrate(claim);
    await deliverIdempotently(batch);
    await contrail.changes.ack(claim);
  } catch {
    await contrail.changes.fail(claim, {
      code: "destination_unavailable",
      nextAttemptAt: Date.now() + 30_000,
    });
  }
}
```

Claims coalesce repeated URIs, hydrate in set-oriented collection queries, and resolve delete/recreate races from newest canonical state. Consumers lease and progress independently; irrelevant position ranges advance without invoking a handler. Delivery is intentionally at least once—a destination success followed by an acknowledgement crash causes duplicate delivery. Handlers must be idempotent by stable record/document key.

`initial: "current"` uses a durable snapshot-plus-tail coordinator. Repeatedly claim and idempotently acknowledge `contrail.changes.claimSnapshotPage()`, then drain `claimBootstrapChanges()` through its fixed target using ordinary hydrate/ack. Finally claim the stable generation-scoped activation token with `claimActivation()`, perform an idempotent destination swap, and call `completeActivation()`. A crash replays the same URI page, tail range, or activation token. Records updated or deleted while the keyset scan races are corrected by the anchored tail.

A consumer can be added to a populated log when all of its collection/phase pairs were already covered; its current/future anchor is the atomic current head, while history starts at the retained floor. Expanding coverage still fails closed without a fresh generation or explicit old-writer quiet boundary. `contrail changes status`, `retry`, `prune`, and explicitly confirmed `skip` expose private operations for SQLite or Wrangler D1 deployments. Pruning is bounded by the slowest durable consumer/bootstrap anchor. Skip records a bounded private audit reason and never occurs implicitly. Disabling or removing an existing log remains fail-closed. With no configured consumers, no change-log tables or append writes exist.

## Local development

A project containing only `contrail.config.ts` can start a complete local service:

```bash
contrail dev
```

Without a Wrangler config this creates or resumes `.contrail/dev.sqlite`, resolves missing configured record/ref Lexicons from the AT Protocol network without overwriting project-owned schemas, runs PDS backfill, serves the complete public Contrail discovery/XRPC/Lexicon surface at `http://127.0.0.1:8787`, and runs bounded Jetstream ingestion every minute. It never creates or changes a deployment provider lock. Add `.contrail/` to the project ignore file. Existing Wrangler projects retain the prior D1 development behavior automatically. Useful SQLite options include:

```bash
contrail dev --fresh                          # reset local SQLite first
contrail dev --temporary                      # delete SQLite when stopped
contrail dev --sqlite ./tmp/dev.sqlite        # explicit durable path
contrail dev --alluvium --allow-partial       # fast base/archive bootstrap
contrail dev --no-backfill                    # serve existing state only
```

Generate the typed consumer API directly from an owned config or its containing directory:

```bash
contrail connect ./contrail.config.ts
contrail connect ../api
```

A config source generates Lexicons, Atcute types, `contrailApi`, `createContrailClient()`, and `createLocalContrailClient()` without creating or changing `contrail.lock.json`. If a production lock already exists, the generated default client keeps that deployment target while the local factory uses the current source API. `contrail dev --config ../api/src/contrail.config.ts` can then run the same config locally.

SQLite dev mode exposes configured protected methods only on loopback without inheriting a production service-auth audience. When `notify` is omitted, it also enables open loopback-only `notifyOfUpdate`. `createLocalContrailClient()` has no OAuth scope and permits plain HTTP only for a validated loopback endpoint.

## Fresh generations (experimental)

`PdsSnapshotSource`, `JetstreamChangeSource`, `DatabaseBootstrapTarget`, and `bootstrapFreshProjection()` build an unpublished database with capture-first replay. The capture mark is durable before relay discovery starts; PDS partition cursors and Jetstream checkpoints commit with their records. Completion rebuilds deferred projections, verifies aggregate record/version consistency, and stores only bounded failure categories.

Jetstream generation replay requires an operator-owned continuity epoch and retention guarantee. It uses real stream events as marks, never wall clock or a quiet socket. Optional busy watermark collections can prove progress without being projected.

An optional experimental Alluvium adapter consumes existing version-1 collection manifests, verifies immutable compressed objects, and ends offline bootstrap exactly at the archived source boundary. The CLI supports either Wrangler/D1 or an explicit SQLite file:

```bash
contrail backfill --sqlite ./data/contrail.sqlite --alluvium \
  --alluvium-epoch my-source-continuity-epoch \
  --allow-partial
```

The epoch is deliberately required because Alluvium protocol v1 does not publish one. `--allow-partial` is needed only when selected manifests explicitly report historical omissions. The command rejects a populated database unless it is resuming durable Alluvium bootstrap state. The equivalent programmatic API is:

```ts
import { DatabaseBootstrapTarget } from "@atmo-dev/contrail";
import {
  createAlluviumBootstrapSources,
  createAlluviumLiveCursor,
} from "@atmo-dev/contrail/alluvium";

const sourceIdentity = {
  id: "jetstream-us-east",
  // Alluvium v1 does not publish an epoch yet; the operator owns this value.
  epoch: "jetstream-us-east-2026-08",
  url: "wss://jetstream1.us-east.bsky.network",
};
const source = createAlluviumBootstrapSources(config, {
  endpoint: "https://alluvium-v0.atmo.tools",
  source: sourceIdentity,
  jetstream: {
    retentionUs: 72 * 60 * 60 * 1_000_000,
    watermarkCollections: ["app.bsky.feed.post"],
  },
});
const target = new DatabaseBootstrapTarget(db, config, {
  deferDerivedProjections: true,
  // Commit the archived time_us as the ordinary cron ingestion cursor.
  liveCursor: createAlluviumLiveCursor(sourceIdentity),
});

await bootstrapFreshProjection({
  collections: ["community.lexicon.calendar.event"],
  ...source,
  target,
});
```

The offline call loads only the base plus published archive tail. It does not replay direct Jetstream to a newly marked head. The target atomically persists Alluvium's final archived `time_us` as the normal live cursor, so subsequent bounded cron invocations resume there and catch up over as many scheduled windows as necessary.

This first adapter is generation-only and deliberately strict: selected manifests must expose one shared base and archive boundary, source ID/URL must match configuration, known capture gaps fail, and partial historical coverage requires `allowPartial: true`. It buffers each bounded compressed object so checksum and byte length are verified before any rows are projected. Because version-1 manifests lack global multi-collection delivery steps, it also restores source order with a bounded 100,000-mutation tail buffer; larger tails require the planned bundle protocol. It does not silently fall back to PDS acquisition; omitted-account repair and dependent profile/follow enrichment remain separately accounted PDS work.

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

Discovery at `/.well-known/contrail` advertises a validated API description and content-addressed Lexicon bundle. Anonymous collection reads, profiles, feeds, and authored custom queries may acquire public AT Protocol data and improve the cache behind the response.

Personalized feeds and `notifyOfUpdate` can instead require method-bound AT Protocol service tokens:

```ts
const config = {
  notify: true,
  serviceAuth: {
    audience: "did:web:api.example.com#contrail",
    methods: ["getFeed", "notifyOfUpdate"],
  },
  // ...
};
```

The service description advertises the base service DID, exact fragmented audience, canonical OAuth scope, and each protected query/procedure separately from anonymous methods. `contrail connect` generates `src/contrail/index.ts`; anonymous calls go directly to the configured endpoint, while protected calls lazily discover and validate all service-auth fields. Its exported `contrail.scope` contains one sorted `lxm` parameter per protected method, such as `rpc?aud=did:web:api.example.com%23contrail&lxm=<namespace>.getFeed&lxm=<namespace>.notifyOfUpdate`. `contrail.authenticated(authenticatedClient)` returns one Atcute client: advertised provider methods route to Contrail, ordinary methods route to the PDS, and successful tracked `createRecord`, `putRecord`, and `deleteRecord` calls automatically notify Contrail. Handle-form deletes are resolved to canonical DID URIs. Protected methods use cached exact method-bound tokens, while transient discovery failures remain retryable. Feed actors must resolve to the token issuer, and every notified AT URI must belong to the issuer. When the base DID resolves to the public endpoint's `/.well-known/did.json`, the Worker publishes a DID document whose service entry ID is the exact audience.

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

Connect an independent consumer with `contrail connect <https-origin>`. The version-2 provider lock records the deployment and exact Lexicon bundle, but generated clients do not pin the provider's complete method set at runtime. Existing anonymous methods therefore continue working when a provider adds methods. A repeated connection to the same endpoint and provider-owned output root requires `--update`; provider files and the lock are staged and swapped without deleting consumer-owned Lexicons. Version-1 locks must be removed and reconnected.

See [Creating a public service](../../docs/public-services/creating.md), [Using a public service](../../docs/public-services/using.md), and [Example: api.atmo.rsvp](../../docs/public-services/api-atmo-rsvp.md) for complete provider and consumer walkthroughs.

## Runtime record validation

Opt collections into validation where their indexing policy is declared:

```ts
const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.example.event",
      validate: true,
    },
    legacy: {
      collection: "community.example.legacy",
      // Omitted or false: compatibility mode, no runtime validation.
    },
  },
  validation: {
    strict: true, // default: enforce blob size/MIME constraints too
    verifyCid: true, // default: canonical DAG-CBOR CID verification
  },
};
```

`createWorker(config, { lexicons })` binds each opted-in collection to the exact generated/pinned bundle already shipped with the deployment. `contrail dev` resolves and binds its exact temporary bundle, while CLI backfill loads the standard checked-in generated bundle. There is no second validation-specific Lexicon array.

Direct runtimes use the same explicit separation between policy and material:

```ts
const contrail = new Contrail({ ...config, db, lexicons });
```

Validation applies identically to Jetstream, PDS backfill, notify, on-demand enrichment, Alluvium, and direct `ingestRecords()` calls. Startup fails when an opted-in collection or transitive reference is absent from the bound bundle. Authoritative sources must provide matching CIDs; local and Constellation synthetic records may be CID-less by default. Override `allowCidlessSources` only for explicitly trusted synthetic adapters.

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
