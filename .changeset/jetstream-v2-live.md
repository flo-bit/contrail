---
"@atmo-dev/contrail": minor
---

Switch scheduled and persistent live ingestion to Jetstream v2 using the official `@bsky/jetstream` client. Live cursors now use instance-local sequence numbers, one normalized v2 service is durably pinned to each generation, legacy timestamp cursors transition atomically into the seq domain, and existing PDS/Alluvium historical acquisition remains unchanged. Alluvium bootstrap now has a separate `sourceUrl`/`--alluvium-source-url` for its legacy v1 manifest identity. Unscoped `getCursor` responses now return `{ cursor }`; ordered-source responses retain their opaque `{ source, epoch, cursor }` position. The minimum supported Node.js version is now 22.15.
