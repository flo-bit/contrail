---
"@atmo-dev/contrail-base": patch
"@atmo-dev/contrail-appview": patch
---

Stop re-ingesting the last 10s on every cron cycle for single-instance jetstream configs.

`@atcute/jetstream` rolls the cursor back 10s on the first connect when given an array `url`, to absorb clock skew across a pool of interchangeable instances. Contrail's cron ingestion rebuilds the subscription every cycle, so for a single-instance config that once-per-session rollback fired every cycle and redundantly re-delivered the last 10s of events. A new `jetstreamUrlOption` helper hands a one-element config to `@atcute` as a string (one fixed instance, no skew, no rollback) while leaving real multi-instance pools as an array so their cross-instance rollback is preserved. Applied at both subscription construction sites (cron `ingestEvents` and the persistent daemon).

The per-cycle reconnect log is now accurate for single-instance configs: a reconnect to one fixed instance no longer claims to "pick a URL at random and roll the cursor back 10s" (it can't). The warning now fires only for multi-instance pools and reports the actual `rolled_back` value; single-instance reconnects log at info level confirming no rollback.
