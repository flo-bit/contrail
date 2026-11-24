---
"@atmo-dev/contrail": minor
---

Remove the transactional change-log / outbox delivery subsystem (`config.changes`, `contrail.changes`, `createWorker` `deliveries` / `changeBootstraps` / `delivery` options, `runPersistentDeliveries`, and `contrail changes` CLI commands).

- Passing a leftover `changes` key in `ContrailConfig` now throws in `validateConfig()`.
- Existing databases that never configured `changes.consumers` keep an unchanged `schema_fingerprint` and continue working without migration.
- Existing databases that previously enabled `changes.consumers` will run a one-time schema check on first `init` and leave the unused `change_*` tables behind (you can drop them manually once upgraded).
