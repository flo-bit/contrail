---
"@atmo-dev/contrail": patch
---

Cache the Hono router and validation context across per-request Worker bindings, deduplicate concurrent cold-start initialization, and fix several core correctness and performance bugs across routing, hydration, feeds, notifications, persistent ingestion, and database adapters.
