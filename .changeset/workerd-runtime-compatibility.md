---
"@atmo-dev/contrail": patch
---

Keep optional CPU telemetry and Jetstream v2 cursor preflights compatible with Cloudflare Workers. Exposed but unimplemented `process.cpuUsage` methods now degrade to `null`, and cursor probes use a receiver-safe fetch call with fail-closed manual redirect handling.
