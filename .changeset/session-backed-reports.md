---
"@atmo-dev/contrail": minor
---

Expose server-only `createModerationReports` operations for embedded applications using their existing authenticated sessions. Share report validation, transaction-safe quotas, moderator authorization, private previews and resolution with the JWT-protected XRPC routes. Keep XRPC authentication unchanged; `moderation.reports: false` disables route exposure without disabling explicit server operations.

Persist bounded PDS profile misses (one day for authoritative absence, one hour for transient failures) so embedded apps do not repeatedly fetch absent profiles. Indexed/live profiles still take precedence. Update the CID dependency for compatibility with current Atcute CBOR releases.
