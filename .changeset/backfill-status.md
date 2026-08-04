---
"@atmo-dev/contrail": patch
---

Keep failed PDS and relay work pending with bounded retries instead of marking account rows complete. Retry due PDS accounts automatically in small scheduled slices with persisted exponential backoff and an overlap lease. Add durable backfill and discovery state to the JSON overview and `/status` endpoint, including running/complete state, pending tasks, retry timing, and unreachable-account counts.
