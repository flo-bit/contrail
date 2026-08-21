---
"@atmo-dev/contrail": minor
---

Add the first transactional projection change-log milestone. Optional static consumer definitions now create a fresh-generation log, durable registrations, and collection/phase coverage ledger. Winning logical URI changes append compact references atomically with canonical records, derived projections, tombstones, and source checkpoints; disabled configurations create no log tables or append writes.

Harden all projection writers with transaction-time predecessor guards and bounded conflict retries so overlapping cron, persistent, notify, and backfill work cannot commit stale canonical or derived state. Add independent bounded consumer leases, filtered/coalesced claims, set-oriented current-state hydration, CAS acknowledgement, failure backoff, lease renewal, private status, and manual retry APIs. Add crash-safe current-state snapshot/tail/activation bootstrap, safe additive consumers over existing coverage, required-consumer readiness gates, consumer-aware bounded pruning, and audited explicit skip operations. Private `contrail changes` commands cover status, retry, prune, and skip. Enabling or expanding log coverage on a populated generation fails closed pending explicit quiet-boundary migration tooling.
