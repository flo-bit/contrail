---
"@atmo-dev/contrail": patch
---

Add durable source ordering metadata and tombstones so stale creates, updates, and deletes cannot replace newer state. Commit live Jetstream cursors atomically with projection, checkpoint only yielded events, preserve failed persistent batches, separate record time from source time, migrate existing rows to version metadata, and update supported dependencies.
