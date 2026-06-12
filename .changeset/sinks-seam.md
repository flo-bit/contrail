---
"@atmo-dev/contrail-base": minor
"@atmo-dev/contrail-appview": minor
---

Add a first-class `sinks` config option: write-only, post-commit observers of applied records.

A `Sink` builds derived state (a search index, an audit log, a webhook fan-out) from every record contrail ingests. Each configured sink's `onRecords(events, { phase })` fires inside `applyEvents()` after the DB commit, on **both** the live and backfill paths, receiving one deduplicated `RecordEvent` per record. Failures are isolated — a throwing sink is logged via the configured logger and never blocks ingestion.

Unlike `realtime.pubsub`, a sink is not a subscriber: it serves no reads, requires no ticket secret, and must see backfilled records (where realtime is intentionally silent). Public records only — space-scoped records publish via the publishing adapter and never reach the fan-out.

Purely additive: `realtime` and all existing behavior are unchanged. Runs identically on D1 and Postgres (it is an in-process call after commit, not a database-log consumer).
