---
"@atmo-dev/contrail": patch
---

Fix `contrail append-scheduled` forwarding through SvelteKit's production CSRF guard by sending `Content-Type: application/json` alongside the configured cron secret. Reject non-success HTTP responses in the `ctx.waitUntil()` promise so authentication and server failures are reported as scheduled failures rather than silent successes. Fetch exceptions continue to propagate.

Consumers must rerun their framework build before `append-scheduled`: previously patched bundles retain the idempotence marker and are not updated in place.
