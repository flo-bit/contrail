# Contrail backfill benchmark

Fresh, repeatable local-D1 benchmarks for complete Contrail discovery and historical backfill runs.

From the repository root:

```bash
pnpm bench --config calendar.config.json
```

`calendar.config.json` mirrors the retained indexing shape from `11-atproto/02-atmo-rsvp`: calendar events, RSVPs, profiles, follows/feeds, query indexes, relation counts, and event full-text search. Removed product modules and read-only pipeline handlers are intentionally absent because they do not participate in indexing. External sinks are also omitted so the benchmark measures Contrail and D1 rather than Meilisearch latency.

## Comparing concurrency

Each command runs in a new Node process and starts from a fresh local D1:

```bash
pnpm bench --config calendar.config.json --concurrency 25
pnpm bench --config calendar.config.json --concurrency 50
pnpm bench --config calendar.config.json --concurrency 100
pnpm bench --config calendar.config.json --concurrency 200
```

The defaults are `--concurrency 100` and `--max-attempts 5`, matching `contrail backfill`. The baseline therefore includes the same immediate retry behavior as an ordinary Atmo RSVP re-backfill. Change only one option at a time after recording that baseline.

Before every run the harness recursively deletes its config/concurrency-specific `.cache` directory. It disposes and deletes the local D1 afterward as well; pass `--keep-cache` only for debugging.

Results are written to ignored JSON files under `results/`. Selected reference runs can be copied into `baselines/`; the first exact-default Atmo RSVP run is [`baselines/calendar-default.json`](baselines/calendar-default.json).

Each result includes:

- binding, schema initialization, discovery, backfill, and total timings;
- accepted and indexed records;
- records per second;
- peak RSS;
- account and per-collection backfill state; and
- the exact concurrency and attempt settings.

## Adding configs

Put portable JSON `ContrailConfig` files in `configs/`. The harness also accepts absolute paths or paths relative to the current directory. JSON configs cannot contain callbacks, custom query functions, or sinks; those should be omitted or represented by a benchmark-specific code harness when they materially affect ingestion.
