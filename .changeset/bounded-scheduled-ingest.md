---
"@atmo-dev/contrail": patch
---

Bound scheduled Jetstream cycles by retained candidate count, distinct identity updates, and serialized bytes; batch identity writes; drop exact transport observations before admission; preserve same-timestamp observations and durable actor scope across capped restarts; capture empty initial cursors safely; reject rollback-prone endpoint pools in scheduled mode; and emit one bounded aggregate cycle summary.
