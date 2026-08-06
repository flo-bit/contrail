---
"@atmo-dev/contrail": minor
---

Add source-neutral snapshot and ordered-change contracts, capture-first bootstrap orchestration, and a database-backed target that commits projection progress atomically for fresh generations. Persist source continuity epochs and the capture mark before snapshot preparation. Add resumable, host-aware relay/PDS snapshots plus source-confirmed Jetstream marks, bounded ordered replay, retention-expiry detection, required source-semantics gates, durable bounded failure categories, aggregate candidate verification, and an immutable deployment-tuple registry with compare-and-swap activation and rollback retention.
