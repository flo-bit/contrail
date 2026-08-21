---
"@atmo-dev/contrail": patch
---

Bound scheduled Jetstream cycles by retained candidate count and serialized bytes, drop exact transport observations before admission, preserve same-timestamp observations across capped restarts, capture empty initial cursors safely, reject rollback-prone endpoint pools in scheduled mode, and emit one bounded aggregate cycle summary.
