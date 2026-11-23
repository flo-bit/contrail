---
"@atmo-dev/contrail": minor
---

Remove the transactional change-log / outbox delivery subsystem (`config.changes`, `contrail.changes`, `createWorker` `deliveries` / `changeBootstraps` / `delivery` options, `runPersistentDeliveries`, and `contrail changes` CLI commands).

Existing databases keep an unchanged schema fingerprint and continue working without migration.
