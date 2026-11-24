# Contrail benchmarks

Deterministic D1 row-cost workloads and live-network discovery/backfill throughput benchmarks. Commands below run from the repository root.

## D1 row costs

```bash
# Small CI matrix, checked against reviewed per-phase ceilings
pnpm test:cost
pnpm bench:cost:ci

# Heavily used app: 1k/10k posts, 100 actors, 50 observations/requests per phase
pnpm bench:cost

# Larger corpus; allow more time on slower machines
pnpm bench:cost --profile heavy --timeout 900000

# Compare the feature layers on the same corpus
pnpm bench:cost --profile ci --preset all

# Custom deterministic workload
pnpm bench:cost --sizes 1000,10000 --actors 100 --operations 100 --seed 42
```

Each fixture gets a fresh, disposable **local-only D1** in a Worker using this app's pinned Wrangler. The Worker bundles the current Contrail source, not potentially stale `dist` files. State is removed afterward, including on failure; there is no remote database option and no deployment, production cursor reset or backfill. Each run freezes the application clock and seeds the same content and relationships. External fetches during workloads are prohibited and counted; unexpected warnings/errors fail the run.

`--sizes` counts **posts**, not total rows. Each post has one comment and one reaction; every fourth post also adds a reaction to one hot parent. Profiles, follows, labels, indexes, FTS and ordering state add further rows. Actor count controls follower fanout and ownership concentration independently of corpus size.

Presets are cumulative:

- `core`: records, field indexes, FTS, references, total/grouped relation counts.
- `moderation`: core plus external labels and private report SQL workloads.
- `full` (default): moderation plus cached profiles and following feeds.

### Workloads and accounting

The JSON report (`apps/benchmark/results/cost-latest.json` by default) includes:

- Creates, updates, deletes, unchanged-CID observations, exact/stale replay, and hot-parent reactions.
- List/filter/search/count-sort queries, keyset pagination (including equality-filtered next/deep pages), feed reads, relation/reference hydration, cached profiles and attached labels.
- Label hide/replay/retraction, account hide/restore, account deactivation/reactivation, moderator action creation/deletion, and label expiry, including queued relation recounts.
- Private report creation, inbox previews, resolution and exhausted-report-quota requests. These use the real routes with a **preauthenticated synthetic gate**: this measures SQL after authentication, not JWT verification/DID-resolution costs.
- Warm schema checks, quiet moderation cycles **without network reconciliation**, and bounded feed-prune pages. These are not a measurement of the complete scheduled acquisition cycle.
- Single-publisher and many-publisher floods, plus `recordFilter: false` exclusions. Reports include admitted/dropped observations, retained-record/ordering-state growth and checkpoint progress. **Publisher admission limits are not implemented by this harness.** Open discoverable publishers are currently accepted; record-filter exclusions still write ordering/tombstone state. The report-quota case separately checks an existing protection: HTTP 429 with no additional report growth.

`rowsRead` / `rowsWritten` come directly from D1 result metadata for **every statement**, including batch members and writes to indexes. They are not returned-row counts, SQL-statement estimates, latency proxies or `EXPLAIN` estimates. The wrapper executes `first()` SQL once through `all()` to retain its metadata. Missing/invalid metadata, partial batch results and uninstrumented statements fail closed. A sanity probe requires a 32-row scan to report more reads than a one-row primary-key lookup and an indexed insert to report more writes than an unindexed one.

Costs are separated into **setup**, **workload** and **verification**. Seed construction uses normal ingestion; it is not a throughput benchmark of the optimized historical bulk-loader. Correctness assertions, counter probes and storage snapshots are verification overhead, never charged to the simulated app's per-operation rates. Reports retain per-phase SQL-template attribution, outcomes, units, elapsed time, D1 `size_after` when available, and retained-row snapshots. Database bytes are diagnostic metadata, not a storage-billing estimate.

Units matter: update phases count **observations**, which can coalesce repeated mutations to a small set of targets; accepted-mutation counts are reported separately. Query phases count requests. Hydration includes its base list query, so do not double-count it as another list request in projections.

The fixture intentionally uses opaque synthetic CIDs and no runtime Lexicon validators. It preloads identities/profiles and calls core ingestion directly. Live acquisition, identity discovery/enrichment after publisher admission, authenticated DID resolution, remote labeler backfill, and public-query rate limits are not modeled. Flood ingestion costs are therefore a **lower bound on the complete pipeline**, not a claim that publisher floods are safe.

### Guardrails and current findings

`baselines/cost-ci.json` contains absolute read/write/statement ceilings per phase for 64/512-post full fixtures. Initial ceilings allow 10% plus 32 reads / 8 writes of slack; zero-write phases retain a zero-write ceiling. Fixture parameters, phase units and pinned Wrangler/Miniflare/workerd versions must match. Timings are informational. CI also checks that cold updates/replay, deletion at fixed fanout, equality-filtered first/next/deep pages and quiet initialization/moderation do not acquire corpus-sized work (per-unit ceiling: 3× the small fixture plus 16 rows). These checks hold fanout, selectivity and timestamp distribution fixed; they do not promise constant reads with arbitrarily many hidden candidates or timestamp ties. Account-wide jobs and hot-parent recounts legitimately depend on affected data and are reported separately.

Account-report previews include labels on their displayed profiles. This adds an indexed URI lookup to label hydration: the CI inbox workload now reads 21 rows/request instead of 15 at both fixture sizes, with no extra statements or writes. Only the two inbox read ceilings were regenerated for this correctness fix; all other ceilings are unchanged.

The initial 1k/10k-post, 100-actor, 50-operation runs identified these costs before the first index optimization pass:

| Operation | Reads/unit at 1k posts | Reads/unit at 10k posts |
| --- | ---: | ---: |
| Cold update observation | 12.34 | 12.34 |
| Delete | 2,019.62 | 19,839.62 |
| Filtered list request | 2,000 | 20,000 |
| Feed request | 101 | 1,001 |

The first pass adds `feed_items(uri)` and replaces single-field equality indexes with `(field, time_us DESC, uri ASC)`, retaining single-field range indexes. The cursor predicate exposes its time bound so a deep filtered page can seek past newer matches. Updated results under the same 1k/10k-post fixture are:

| Operation | Reads/unit at 1k posts | Reads/unit at 10k posts |
| --- | ---: | ---: |
| Delete | 16.12 | 16.12 |
| Filtered list request (20 records) | 60 | 60 |
| Deep filtered page (5 records) | 16 | 16 |

The feed URI index is not free: normal creates in this full-feature fixture increase from **35.96 to 38.92 writes/record**, depending on follower fanout. Replacing an equality index does not add another maintained index; wider keys do add storage. With unchanged app configuration, the preceding schema upgrades by creating replacement indexes before dropping redundant ones, without rebuilding FTS, recounting records or resetting source progress. Building the indexes still has a one-time corpus-sized read/write cost, separate from steady-state costs.

Fixture version 2 adds filtered next/deep-page workloads and tightens the CI ceilings for deletes and filtered lists. Feed reads and feed sweeps remain **investigate** observations and are printed when growth is material; this pass deliberately does not change those algorithms. **Passing today's baseline does not mean all spend is acceptable.** Review the query attribution before raising a ceiling.

Regenerate ceilings only deliberately, after inspecting the diff:

```bash
pnpm bench:cost --profile ci \
  --write-baseline apps/benchmark/baselines/cost-ci.json
```

### Usage projections and limits

```bash
pnpm bench:cost --sizes 10000 \
  --projection apps/benchmark/configs/cost-usage.example.json
```

Projection files provide `days` and `dailyUnits` keyed by workload phase name. The report computes measured rows/unit × requested units/day × days for each fixture. Omitted phases contribute zero; setup/verification cannot be projected as daily activity. The example is illustrative, not a complete app traffic model. No USD prices or plan allowances are hardcoded: apply current, dated D1 pricing to the row estimates separately.

These are **local emulator counters**, useful for deterministic regression checks. **Remote billing equivalence has not been calibrated**; that requires a separately approved disposable remote-D1 experiment. Projections assume the measured data shape and are not billing guarantees, pre-execution budgets or production circuit breakers. This work changes no production admission/moderation behavior.

## Historical backfill throughput

Fresh, repeatable local-D1 benchmarks for complete Contrail discovery and historical backfill runs.

From the repository root:

```bash
pnpm bench --config calendar.config.json
```

D1 is the default backend. Use `--backend sqlite` for a fresh in-memory native SQLite run; the result records Node and SQLite versions and gains `-sqlite` in its filename:

```bash
pnpm bench --backend sqlite --config calendar-records-only.config.json
```

`calendar.config.json` mirrors a full event/RSVP AppView indexing shape: calendar events, RSVPs, profiles, follows/feeds, query indexes, relation counts, and event full-text search. Removed product modules and read-only pipeline handlers are intentionally absent because they do not participate in indexing.

To run the same full workload with strict runtime Lexicon validation and canonical DAG-CBOR CID verification enabled:

```bash
pnpm bench --config calendar.config.json \
  --validation-lexicons apps/benchmark/lexicons/calendar
```

The validated run uses the same config, scheduling limits, and fresh-D1 lifecycle. Its result filename gains `-validated`, records the Lexicon directory/document count, and includes aggregate rejection diagnostics. Compare validation overhead only against an adjacent run with identical limits; live-network differences still need alternating repetitions before they are treated as stable.

## Pinned benchmark runtime

This benchmark app pins Wrangler 4.84.1 and its compatible Workers types. Wrangler 4.118.0/workerd 1.20260730.1 made the matched records-only local-D1 workload roughly 2.4× slower than workerd 1.20260421.1, including HTTP and identity phases that Contrail's source-ordering code does not control. Other example and deployment apps remain on the current Wrangler release.

Do not update the benchmark runtime as ordinary dependency housekeeping. Rebaseline it deliberately, record both Wrangler and workerd versions, and run old/new Contrail code under the same runtime before attributing a change to Contrail. Every new result includes Node, Wrangler, and workerd versions for this reason.

For a narrow source/storage comparison, `calendar-records-only.config.json` indexes only calendar events and RSVPs. It explicitly disables profiles, follows, feeds, FTS, relation counts, field-query indexes, and Constellation. The retained [`calendar-records-only-comparison.json`](baselines/calendar-records-only-comparison.json) compares this workload with HappyView using matched 100-resolution, 10-PDS, and 3-DID limits; it also records Contrail's validated 20-PDS D1 setting.

## Comparing concurrency

Each command runs in a new Node process and starts from a fresh local D1. Identity resolution, active PDS hosts, and accounts per PDS are separate controls:

```bash
pnpm bench --config calendar.config.json --concurrency 100
pnpm bench --config calendar.config.json --pds-concurrency 5 --dids-per-pds 3
pnpm bench --config calendar.config.json --pds-concurrency 10 --dids-per-pds 3
pnpm bench --config calendar.config.json --pds-concurrency 20 --dids-per-pds 3
pnpm bench --config calendar-records-only.config.json --pds-concurrency 10 --dids-per-pds 3
```

The current defaults are 100 concurrent identity resolutions, 20 active PDS hosts, 3 accounts per PDS, and one immediate attempt. Failures retain their cursor and move to scheduled cron retries instead of slowing the initial pass. The checked-in 774.49-second baseline records the older global-concurrency/5-attempt behavior and remains the historical comparison point.

Before every run the harness recursively deletes its config/concurrency-specific `.cache` directory. It disposes and deletes the local D1 afterward as well; pass `--keep-cache` only for debugging.

Results are written to ignored JSON files under `results/`. Selected reference runs live in `baselines/`: [`calendar-default.json`](baselines/calendar-default.json) is the original 774.49-second global-concurrency run, [`calendar-host-aware.json`](baselines/calendar-host-aware.json) is the 219.74-second host-aware result with set-based derived projection rebuilds, and [`calendar-pipelined.json`](baselines/calendar-pipelined.json) is the comparable 134.98-second result after streaming identity resolution and atomically checkpointing projected pages. [`calendar-runtime-comparison.json`](baselines/calendar-runtime-comparison.json) isolates the local workerd regression from Contrail changes, [`calendar-validation-comparison.json`](baselines/calendar-validation-comparison.json) retains the final adjacent validation-disabled/enabled D1 pair, and [`calendar-sqlite-validated.json`](baselines/calendar-sqlite-validated.json) records the validated native-SQLite records-only run.

Each result includes:

- binding, schema initialization, discovery, backfill, and total timings;
- accepted and indexed records;
- records per second;
- peak RSS;
- exact Node plus Wrangler/workerd or native SQLite versions;
- account and per-collection backfill state;
- bounded aggregate ingest rejection diagnostics;
- validation/CID settings when enabled; and
- the exact resolution, PDS-host, per-PDS account, and attempt settings.

## Validation fixtures

`lexicons/calendar/` contains the exact record schemas needed by the full calendar workload, including transitive references. The `community.lexicon.*` documents mirror the RSVP application's pulled Lexicons. The `app.bsky.*` and `com.atproto.*` documents come from Atcute's 0BSD-licensed definition packages. They are checked in so validation benchmarks do not depend on a mutable registry during a timed run.

## Adding configs

Put portable JSON `ContrailConfig` files in `configs/`. The harness also accepts absolute paths or paths relative to the current directory. JSON configs cannot contain callbacks or custom query functions; those should be omitted or represented by a benchmark-specific code harness when they materially affect ingestion.
