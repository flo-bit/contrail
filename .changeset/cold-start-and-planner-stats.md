---
"@atmo-dev/contrail-appview": minor
"@atmo-dev/contrail-base": minor
---

perf: gate schema replay on a fingerprint; add opt-in planner-stat maintenance

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
maintenance: { optimize: true }            // or { intervalMs, analysisLimit }
```

When enabled, the ingest tick runs a CPU-bounded `PRAGMA analysis_limit=400;
PRAGMA optimize` on a persisted daily cadence (stored in `_contrail_meta`, so it
isn't defeated by recycled isolates — the same in-memory-state bug the feed
prune had). `analysis_limit` bounds the work so it can't exceed D1's per-query
CPU budget and reset the DO. Also exposed as `contrail.optimize(db)` for
consumers that prefer to schedule it themselves. No-op on Postgres
(autovacuum/autoanalyze handles planner stats).
