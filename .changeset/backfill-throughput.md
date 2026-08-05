---
"@atmo-dev/contrail": patch
---

Group historical fetches by PDS with bounded per-host concurrency, stream resolved identities directly into host workers, cancel timed-out requests, defer failed initial accounts to scheduled retries, atomically commit canonical pages with cursor checkpoints, and rebuild FTS and relation counts with set-based SQL after canonical bulk loading. SQLite batches now use synchronous transactions so concurrent backfill work cannot overlap or partially commit.
