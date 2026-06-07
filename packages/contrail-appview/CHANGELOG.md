# @atmo-dev/contrail-appview

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
