---
"@atmo-dev/contrail": patch
---

Keep failed PDS and relay work pending with bounded retries instead of marking account rows complete. Retry due PDS accounts automatically in small scheduled slices with persisted exponential backoff up to 48 hours, a ten-attempt limit, and an overlap lease. Add durable backfill and discovery state to the JSON overview and `/status` endpoint, including running/complete state, retry timing, per-collection progress, and mutually exclusive complete/pending/retrying/failed account counts.
