---
"@atmo-dev/contrail": minor
---

Add per-collection `repos` allowlists for indexing records from explicit publishing DIDs. Seed exact repository/collection backfill pairs without relay discovery, enforce publisher scope across live ingestion, backfill, snapshots and notify, and block out-of-scope record read-through. Persist registered scopes and require a projection rebuild before changing them. Existing collection defaults remain unchanged.
