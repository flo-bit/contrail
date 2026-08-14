---
"@atmo-dev/contrail": minor
---

Add an optional experimental Alluvium fresh-generation adapter plus D1 and SQLite `contrail backfill --alluvium` workflows. Add a zero-configuration SQLite `contrail dev` service with automatic Lexicon resolution, backfill, bounded live ingestion, localhost public-service discovery, stable local consumer lock/type/client generation, and loopback-only open notify without fictitious service auth. Add per-collection `validate: true`, bound to the exact generated runtime bundle with shared CID/strictness knobs; omitted or false collections remain unvalidated. Auto-added profile/follow collections no longer create generic public methods. The Alluvium adapter pins compatible version-1 collection manifests, verifies immutable gzip objects before projection, resumes multipart bases, replays archived puts/deletes, and atomically seeds the normal live cursor at the archive boundary under an operator-owned continuity epoch.
