---
"@atmo-dev/contrail": patch
---

Repair a missing `moderation_effective_labels` view even when the stored schema fingerprint matches. Check view existence in the existing metadata read and recreate only the view, without rebuilding search, rewriting records, resetting cursors or changing moderation policy. Healthy initialization retains its single-read, zero-DDL fast path.

Replace the SQLite/D1 moderation view in one atomic batch during full schema upgrades, so an interrupted or failed replacement cannot leave a committed DROP without its CREATE. PostgreSQL continues to use atomic `CREATE OR REPLACE VIEW`.
