---
"@atmo-dev/contrail": patch
---

Keep failed PDS and relay work pending with bounded retries instead of reporting partial backfills as complete. Add durable backfill and discovery state to the JSON overview and `/status` endpoint, including pending tasks and unreachable-account counts.
