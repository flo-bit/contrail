# Contrail backfill benchmark

Fresh, repeatable acquisition and local-database benchmarks for Contrail backfills.

## Jetstream v2 source replay

The source benchmark drains the official Jetstream v2 sealed archive through `@bsky/jetstream`, folds creates, updates, deletes, account deletions, and repository-sync markers in memory, and records both transfer size and average throughput. It intentionally has no database sink, so it measures source acquisition and SDK decoding rather than Contrail projection time.

Bluesky's hosted historical endpoints require an API key from [bsky.network/account](https://bsky.network/account#api-keys-section-heading). From the repository root:

```bash
JETSTREAM_API_KEY=... pnpm bench:source
```

The default collection is `xyz.statusphere.status`. A different collection, endpoint, sequence window, or SDK download concurrency can be selected explicitly:

```bash
JETSTREAM_API_KEY=... pnpm bench:source \
  --collection app.bsky.feed.post \
  --service https://jetstream.us-west.bsky.network \
  --after-seq 0 \
  --block-concurrency 8
```

Lifecycle markers are included by default because omitting account deletes and repository syncs can leave stale records in a folded current-state view. `--commits-only` is available only for a deliberately narrower transfer comparison.

Each ignored result under `results/` records wall time, downloaded response bytes, processed and current record-payload bytes, source event/commit counts, folded current records and actors, MiB/s, events/s, commits/s, request-level bytes/statuses, runtime version, and peak RSS. Downloaded bytes count response-body bytes actually consumed by the SDK; archive blocks are already compressed by Jetstream and this matches the useful metered payload measurement (HTTP headers are excluded).

The retained [`jetstream-v2-statusphere-commits-only.json`](baselines/jetstream-v2-statusphere-commits-only.json) run loaded 14,020 Statusphere commits in 326.13 seconds. The planner selected 2,008 archive blocks totaling 623.90 MiB for 1.05 MiB of matching record payload, an important measure of sparse-filter overfetch rather than a claim that Statusphere itself contains 623.90 MiB of records.

For a direct current-state comparison, `relay-pds` fully paginates `com.atproto.sync.listReposByCollection`, resolves each discovered DID, and then fully paginates `com.atproto.repo.listRecords` on the owning PDS. Every network request gets exactly one attempt:

```bash
pnpm bench:source --source relay-pds
```

The retained [`relay-pds-statusphere-no-retries.json`](baselines/relay-pds-statusphere-no-retries.json) run used the standard 100-resolution / 20-host × 3-DID limits:

| Measure | Jetstream v2 commits only | Relay + PDS, no retries |
|---|---:|---:|
| Wall time | 326.13s | **32.97s** |
| Response bodies consumed | 623.90 MiB | **2.56 MiB** |
| Records delivered | **14,020** | 9,021 |
| Actors represented | **1,692** | 910 |
| Records/s | 42.99 | **273.57** |
| HTTP requests | **2,009** | 3,674 |
| Completion | sealed archive complete | 928 accounts complete; 412 failed; 1 unresolved |

The direct run was 9.89× faster and consumed about 244× fewer decoded response-body bytes, but it is not an equal-completeness win: only 928 of 1,340 resolved accounts completed without another attempt. Of the 412 failed accounts, 388 returned `400 InvalidRequest`; the remainder were `502`/`503`, transport, timeout, or malformed-response failures. It produced 64.3% as many records as the Jetstream run. Also note that Fetch exposes response bodies *after* HTTP content decoding: Jetstream's `.jss` blocks used identity HTTP encoding and are still internally compressed, while many PDS JSON responses used gzip, Brotli, or zstd on the wire.

The same comparison for `community.lexicon.calendar.rsvp` is retained in [`jetstream-v2-calendar-rsvp-commits-only.json`](baselines/jetstream-v2-calendar-rsvp-commits-only.json) and [`relay-pds-calendar-rsvp-no-retries.json`](baselines/relay-pds-calendar-rsvp-no-retries.json):

| Measure | Jetstream v2 commits only | Relay + PDS, no retries |
|---|---:|---:|
| Wall time | 306.47s | **32.86s** |
| Response bodies consumed | 562.34 MiB | **3.39 MiB** |
| Source mutations / records | **6,731** | 6,318 |
| Folded current records | **6,691** | 6,318 |
| Actors represented | **1,638** | 1,467 |
| Records/s | 21.96 | **192.29** |
| HTTP requests | **1,791** | 4,559 |
| Completion | sealed archive complete | 1,498 accounts complete; 37 failed; 1 unresolved |

For RSVP, direct loading was 9.33× faster, consumed about 166× fewer decoded response-body bytes, and delivered 8.76× as many records per second. It reached 94.4% of Jetstream's folded current-record count and 89.6% of its actor count. The 37 failed direct accounts comprised 26 `400 InvalidRequest` responses, one `502`, one `530`, four transport failures, and five timeouts; two accounts were partial. Jetstream emitted 40 deletes, so its 6,691 folded records—not its 6,731 source mutations—are the relevant current-state comparison against PDS snapshots.

Two smaller complete comparisons further isolate sparse archive-block overfetch:

| Collection and source | Wall time | Response bodies | Current records | Actors | Records/s | Completion |
|---|---:|---:|---:|---:|---:|---|
| `tech.waow.ken.profile` — Jetstream | 4.72s | 7.16 MiB | 21 | 21 | 4.45 | complete |
| `tech.waow.ken.profile` — relay/PDS | **3.96s** | **10.01 KiB** | 21 | 21 | **5.30** | 21/21 accounts |
| `app.lexidraw.scene` — Jetstream | 12.62s | 22.85 MiB | 68 | 53 | 5.86 | complete |
| `app.lexidraw.scene` — relay/PDS | **4.52s** | **50.66 KiB** | 68 | 53 | **15.04** | 55/55 accounts |

For `tech.waow.ken.profile`, direct loading was 1.19× faster and consumed 732× fewer decoded response-body bytes while returning the identical 21-record state. Results: [`jetstream-v2-ken-profile-commits-only.json`](baselines/jetstream-v2-ken-profile-commits-only.json) and [`relay-pds-ken-profile-no-retries.json`](baselines/relay-pds-ken-profile-no-retries.json).

For `app.lexidraw.scene`, direct loading was 2.79× faster and consumed 462× fewer decoded response-body bytes while returning the identical 68-record/53-actor state. Jetstream delivered 74 mutations (50 creates, 20 updates, and 4 deletes) before folding. Results: [`jetstream-v2-lexidraw-scene-commits-only.json`](baselines/jetstream-v2-lexidraw-scene-commits-only.json) and [`relay-pds-lexidraw-scene-no-retries.json`](baselines/relay-pds-lexidraw-scene-no-retries.json).

### Lifecycle-marker plan estimate

Commits-only replay sees record-level deletes but not DID-wide account deletion or repository-sync markers. Adding `account` and `sync` naively is extremely expensive because Jetstream's `collections` filter constrains commits only; without a DID filter, lifecycle markers are selected for the whole network.

The retained metadata-only [`jetstream-v2-marker-plan-estimates.json`](baselines/jetstream-v2-marker-plan-estimates.json) queried `planSnapshot` plus paginated `listSegments` without downloading any `getSegment` or `getBlock` body. At sealed seq 24,828,091,236:

| Collection | Whole segments | Individual blocks | Estimated data | Estimated time at 1.83 MiB/s |
|---|---:|---:|---:|---:|
| `tech.waow.ken.profile` | 166 | 16,336 | 38.93 GiB | 6.05h |
| `app.lexidraw.scene` | 166 | 16,354 | 38.93 GiB | 6.05h |

The 166 whole segments account for an exact 33.07 GiB. Partial-block bytes are estimated from those segments' exact sizes and planner block count, adding about 5.86 GiB. Across the 1.52–1.91 MiB/s rates observed in retained Jetstream runs, either plan would take roughly 5.8–7.3 hours. The near-identical plans confirm that global lifecycle markers, not either tiny collection, dominate acquisition.

A practical adapter therefore needs DID-scoped lifecycle acquisition while preserving sequence order; applying an independently downloaded marker pass after all commits would misorder sync markers and replacement records.

## Contrail database backfill

From the repository root:

```bash
pnpm bench --config calendar.config.json
```

D1 is the default backend. Use `--backend sqlite` for a fresh in-memory native SQLite run; the result records Node and SQLite versions and gains `-sqlite` in its filename:

```bash
pnpm bench --backend sqlite --config calendar-records-only.config.json
```

`calendar.config.json` mirrors the retained indexing shape from `11-atproto/02-atmo-rsvp`: calendar events, RSVPs, profiles, follows/feeds, query indexes, relation counts, and event full-text search. Removed product modules and read-only pipeline handlers are intentionally absent because they do not participate in indexing.

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
