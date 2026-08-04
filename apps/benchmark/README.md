# Contrail backfill benchmark

Fresh, repeatable local-D1 benchmarks for complete Contrail discovery and historical backfill runs.

From the repository root:

```bash
pnpm bench --config calendar.config.json
```

`calendar.config.json` mirrors the retained indexing shape from `11-atproto/02-atmo-rsvp`: calendar events, RSVPs, profiles, follows/feeds, query indexes, relation counts, and event full-text search. Removed product modules and read-only pipeline handlers are intentionally absent because they do not participate in indexing. External sinks are also omitted so the benchmark measures Contrail and D1 rather than Meilisearch latency.

## Comparing concurrency

Each command runs in a new Node process and starts from a fresh local D1. Identity resolution, active PDS hosts, and accounts per PDS are separate controls:

```bash
pnpm bench --config calendar.config.json --concurrency 100
pnpm bench --config calendar.config.json --pds-concurrency 5 --dids-per-pds 3
pnpm bench --config calendar.config.json --pds-concurrency 10 --dids-per-pds 3
pnpm bench --config calendar.config.json --pds-concurrency 20 --dids-per-pds 3
```

The current defaults are 100 concurrent identity resolutions, 20 active PDS hosts, 3 accounts per PDS, and one immediate attempt. Failures retain their cursor and move to scheduled cron retries instead of slowing the initial pass. The checked-in 774.49-second baseline records the older global-concurrency/5-attempt behavior and remains the historical comparison point.

Before every run the harness recursively deletes its config/concurrency-specific `.cache` directory. It disposes and deletes the local D1 afterward as well; pass `--keep-cache` only for debugging.

Results are written to ignored JSON files under `results/`. Selected reference runs live in `baselines/`: [`calendar-default.json`](baselines/calendar-default.json) is the original 774.49-second global-concurrency run, while [`calendar-host-aware.json`](baselines/calendar-host-aware.json) is the comparable 219.74-second host-aware run with set-based derived projection rebuilds.

Each result includes:

- binding, schema initialization, discovery, backfill, and total timings;
- accepted and indexed records;
- records per second;
- peak RSS;
- account and per-collection backfill state; and
- the exact resolution, PDS-host, per-PDS account, and attempt settings.

## Adding configs

Put portable JSON `ContrailConfig` files in `configs/`. The harness also accepts absolute paths or paths relative to the current directory. JSON configs cannot contain callbacks, custom query functions, or sinks; those should be omitted or represented by a benchmark-specific code harness when they materially affect ingestion.
