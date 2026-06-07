---
"@atmo-dev/contrail-appview": minor
---

fix(feeds): make feed_items pruning bounded so it can't reset the D1 DO

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
