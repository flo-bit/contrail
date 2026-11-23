---
"@atmo-dev/contrail": patch
---

Fix PostgreSQL 17 runtime issues found by live PostgreSQL tests: handle `42710` (`duplicate_object`) and route FTS/count index DDL through `runIdempotentDdl` during concurrent `initSchema`, and avoid an untyped `(? IS NULL OR position <= ?)` parameter in `claimChangeRange`.
