---
"@atmo-dev/contrail": minor
---

Add the first transactional projection change-log milestone. Optional static consumer definitions now create a fresh-generation log, durable registrations, and collection/phase coverage ledger. Winning logical URI changes append compact references atomically with canonical records, derived projections, tombstones, and source checkpoints; disabled configurations create no log tables or append writes.

Harden all projection writers with transaction-time predecessor guards and bounded conflict retries so overlapping cron, persistent, notify, and backfill work cannot commit stale canonical or derived state. Add independent bounded consumer leases, filtered/coalesced claims, set-oriented current-state hydration, CAS acknowledgement, failure backoff, lease renewal, private status, and manual retry APIs plus `contrail changes status/retry` commands. Enabling or changing log coverage on a populated generation fails closed pending explicit quiet-boundary migration tooling.
