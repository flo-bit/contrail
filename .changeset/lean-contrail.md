---
"@atmo-dev/contrail": minor
---

Collapse Contrail into one public package and one AppView implementation. Remove the spaces, authority, record-host, community, realtime, sync, and custom Lexicon-tooling products. Route Jetstream, persistent, backfill, refresh, and immediate synchronization records through the shared `ingestRecords` admission and projection path. Make materialized relation counts converge when children arrive before parents, and prevent transient PDS failures from being interpreted as authoritative deletions.
