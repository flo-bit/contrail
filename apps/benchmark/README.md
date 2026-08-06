# Contrail backfill benchmark

Fresh, repeatable local-D1 benchmarks for complete Contrail discovery and historical backfill runs.

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
