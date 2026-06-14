---
"@atmo-dev/contrail-appview": patch
---

Persist the jetstream ingest cursor before the identity-refresh tail in `runIngestCycle`.

`saveCursor` previously ran after `refreshStaleIdentities`, whose per-DID network calls can run long. If the ingest isolate was aborted (e.g. a scheduled-invocation deadline) before the save, the cursor never advanced and the next cycle re-drained the same jetstream window indefinitely. Records are durably applied before this point, so the cursor is now saved first; identity refresh is idempotent and staleness-driven, so deferring it past the save is safe.
