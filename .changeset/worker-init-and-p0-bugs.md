---
"@atmo-dev/contrail": patch
---

Cache the Hono router and validation context across per-request Worker bindings, deduplicate concurrent cold-start initialization, and fix several core correctness and performance bugs across routing, hydration, feeds, notifications, persistent ingestion, and database adapters.

Note for PostgreSQL / PGlite callers: `INT8` / `BIGINT` columns (including aggregate results such as `COUNT(*)`) are now coerced to `number` based on PostgreSQL OID 20 rather than only a hardcoded column-name list.
