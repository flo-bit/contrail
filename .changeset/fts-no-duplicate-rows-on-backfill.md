---
"@atmo-dev/contrail-appview": patch
---

Stop accumulating duplicate FTS rows when records are re-applied during backfill.

The FTS-sync path only deleted an existing FTS row before inserting when the
record was already in `existingMap`. Backfill runs with `skipReplayDetection`,
which leaves `existingMap` empty, so every re-applied record looked brand-new
and appended another FTS row. The FTS virtual table has no uniqueness
constraint, so these accumulated, and the search JOIN fanned each event out into
one result row per duplicate. Make the delete-then-insert unconditional so FTS
sync is idempotent regardless of replay detection.
