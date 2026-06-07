# @atmo-dev/contrail-appview

## 0.11.0

### Minor Changes

- 1aeee9a: feat(getRecord): resolve a handle in the URI authority

  `<ns>.<collection>.getRecord` now accepts an AT-URI whose authority is a handle
  (e.g. `at://alice.bsky.social/<coll>/<rkey>`), not just a DID. The authority is
  resolved through the same `resolveActor` the actor-param endpoints
  (`listRecords`/`getProfile`/`getFeed`) already use — local-first via the indexed
  `identities` table, network only on a miss — so a handle-routed consumer can
  hand the URI straight to `getRecord` instead of resolving handle→DID itself.

  Fully backward compatible: a DID authority resolves to itself unchanged, so
  existing DID-URI callers are unaffected. Applies to both the public and
  per-space (`?spaceUri=`) paths. `getRecord` stays a fast read — no blocking
  backfill is added. Unresolvable authority → 400 (matching `listRecords`),
  missing record → 404. Parsing now uses atcute's `parseResourceUri`, which
  validates the actor / NSID / record-key shapes, so a syntactically invalid
  `uri` returns 400 instead of silently 404ing.

  Internal: the hand-rolled `parseAtUri` (notify) is reimplemented over atcute's
  `parseCanonicalResourceUri`; its signature is unchanged.

### Patch Changes

- @atmo-dev/contrail-base@0.11.0
- @atmo-dev/contrail-authority@0.11.0
- @atmo-dev/contrail-record-host@0.11.0

## 0.10.0

### Minor Changes

- 89aee1b: perf: gate schema replay on a fingerprint; add opt-in planner-stat maintenance

  Two independent performance fixes found while profiling a D1 consumer.

  **Cold-start schema replay (always on).** `initSchema` ran ~40 base/collection/
  index/fts/feed/spaces DDL statements serially on every `init()` call, with no
  gate. Consumers call `init()` once per isolate and Workers isolates recycle
  constantly, so the first request to each cold isolate paid ~40 sequential
  round-trips to the D1 storage object before any real work. `initSchema` now
  records a fingerprint of the resolved schema (hash of the generated DDL +
  `CONTRAIL_SCHEMA_VERSION`) in a new `_contrail_meta` table and, on a match,
  skips all DDL after a single read. Steady-state cold start drops from ~40
  round-trips to one; the full apply only runs on first init or an actual schema
  change. Concurrent-init safety on Postgres is unchanged (the gate just wraps the
  existing idempotent apply).

  **Query-planner statistics (opt-in).** Without `ANALYZE`, SQLite's planner picks
  the least-selective index for multi-predicate queries (measured ~50x more rows
  read on a `subject.uri` + `status` filter). New opt-in config:

  ```ts
  maintenance: {
    optimize: true;
  } // or { intervalMs, analysisLimit }
  ```

  When enabled, the ingest tick runs a CPU-bounded `PRAGMA analysis_limit=400;
PRAGMA optimize` on a persisted daily cadence (stored in `_contrail_meta`, so it
  isn't defeated by recycled isolates — the same in-memory-state bug the feed
  prune had). `analysis_limit` bounds the work so it can't exceed D1's per-query
  CPU budget and reset the DO. Also exposed as `contrail.optimize(db)` for
  consumers that prefer to schedule it themselves. No-op on Postgres
  (autovacuum/autoanalyze handles planner stats).

### Patch Changes

- Updated dependencies [89aee1b]
  - @atmo-dev/contrail-base@0.10.0
  - @atmo-dev/contrail-authority@0.10.0
  - @atmo-dev/contrail-record-host@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [4c8fedb]
  - @atmo-dev/contrail-base@0.9.1
  - @atmo-dev/contrail-authority@0.9.1
  - @atmo-dev/contrail-record-host@0.9.1

## 0.9.0

### Minor Changes

- 8f0b87e: fix(feeds): make feed_items pruning bounded so it can't reset the D1 DO

  The hourly feed prune ran a single global `ROW_NUMBER() OVER (PARTITION BY actor)`
  window + `(actor, uri) NOT IN (...)` anti-join across the entire `feed_items`
  table — O(n) CPU in one statement. Once the table grew large this exceeded D1's
  per-query CPU limit and reset the shared Durable Object, taking down any
  concurrent read on the same SQLite instance (unrelated user requests 500'd with
  `was reset` / `Network connection lost`). Because the statement reset before
  completing, caps were never enforced, the table kept growing, and the prune got
  more expensive — a death spiral.

  Changes:

  - **Bounded per-actor prune.** Pruning is now an index-backed cutoff delete per
    `(actor, collection)` using `idx_feed_actor_coll_time`, cost O(cap), never
    O(table). New `pruneActorFeed` / `sweepFeedItems` exports; the ingest loops
    run one bounded `sweepFeedItems` slice per tick (`FEED_PRUNE_SWEEP_ACTORS`
    actors), which also serves as recovery for already-bloated tables.
  - **Persisted prune cursor.** A new `feed_prune_cursor` row tracks the rolling
    sweep position, so progress survives the cron isolate recycling that
    previously made the in-memory hourly gate a no-op (it pruned on essentially
    every tick). The time gate is removed from the cron path; the long-lived
    persistent loop keeps a short in-memory throttle.
  - **API:** `pruneFeedItems(db, caps)` now accepts only the per-collection
    `Map<collection, cap>` (the legacy global-number form is removed) and is
    reimplemented as a bounded full-table recovery loop — keep it off the hot
    path.

  The follow fan-out's `subject` lookup is already covered by `idx_<follow>_subject`,
  so no unbounded statement remains in the ingest path.

### Patch Changes

- @atmo-dev/contrail-base@0.9.0
- @atmo-dev/contrail-authority@0.9.0
- @atmo-dev/contrail-record-host@0.9.0

## 0.8.0

### Minor Changes

- d7e0936: Private-network deployment support via a new optional `ContrailConfig.networkOverrides` block.

  `networkOverrides` carries three optional subfields, all defaulting to the current public-internet behavior (omit the block entirely and nothing changes):

  - **`resolver`** — a custom `DidDocumentResolver` used during DID-doc PDS fallback, labeler-endpoint resolution, and spaces service-auth JWT verification. Lets a deployment point at a private PLC mirror or inject a custom fetch (mTLS, retry, instrumentation). Trusted; not SSRF-checked.
  - **`slingshotUrl`** — override the slingshot identity-resolver endpoint. Trusted; not SSRF-checked.
  - **`additionalAllowedHosts`** — hostnames that bypass the default SSRF guard when validating a resolved PDS or labeler endpoint. Match is exact, case-insensitive, port-agnostic (e.g. `["pds.dev.svc.cluster.local"]`). This is the only knob that widens the validator; there is no "disable SSRF" flag.

  The overrides are threaded through PDS/identity resolution (`resolvePDS`, `getPDS`, `getClient`, `resolveIdentity*`, `refreshStaleIdentities`), labeler endpoint resolution and ingest (`resolveLabelerEndpoint`, `getLabelerState`, label subscribe cycles), and service-auth verification (`buildVerifier` in both the appview router and the community integration). The in-scope `config` is now also passed at every appview call site that resolves identities or PDS endpoints — the live-ingest refresh cycle (`runIngestCycle` → `refreshStaleIdentities`), the on-demand `refresh` path, and the router actor/identity/PDS resolution paths (`getProfile`, `getFeed`, collection queries, profile hydration, notify) — so private-network deploys honor the override on those paths instead of silently falling back to the public resolver and un-widened SSRF guard.

  The SSRF guard is now a single shared validator: `validateExternalUrl(url, additionalAllowedHosts?)` is exported from `contrail-base` and consumed by both the PDS client and labeler-endpoint resolution. `validateEndpointUrl` remains exported as a thin alias for backward compatibility. This removes the previous duplicate validator (`validatePdsUrl` + `validateEndpointUrl`) where an allowlist or SSRF-rule edit could be applied to only one copy.

  Also hardens schema initialization for concurrent/Postgres deployments: a dialect-aware `addColumnIfNotExists` (Postgres `ADD COLUMN IF NOT EXISTS`; SQLite pre-check), narrow absorption of the Postgres concurrent-`CREATE` race (42P07 / 23505 on pg_type/pg_class/pg_namespace indexes), and per-statement (rather than batched) DDL during `initSchema` / `initSpacesSchema` / spaces schema. Genuine DDL errors (syntax, type mismatch, missing column/table) still propagate.

### Patch Changes

- Updated dependencies [d7e0936]
  - @atmo-dev/contrail-base@0.8.0
  - @atmo-dev/contrail-authority@0.8.0
  - @atmo-dev/contrail-record-host@0.8.0

## 0.7.0

### Patch Changes

- @atmo-dev/contrail-base@0.7.0
- @atmo-dev/contrail-authority@0.7.0
- @atmo-dev/contrail-record-host@0.7.0
