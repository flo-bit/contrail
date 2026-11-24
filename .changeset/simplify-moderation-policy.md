---
"@atmo-dev/contrail": minor
---

Simplify moderation policy handling by removing the rolling multi-deployment policy-swap state machine and generation write guards:

- Remove `core/moderation-policy.ts`, `runModerationPolicyJob`, policy-generation nonces/write guards in label ingestion and backfill, `ModerationWriteGuard`, and `ContrailInitOptions` / `deferModerationPolicyJob` (callers passing `{ deferModerationPolicyJob: true }` to `contrail.init(db)` can remove the second argument).
- Replace with a lightweight `syncModerationSources` check on `initSchema` (still outside `schema_fingerprint` with zero writes on warm init). Changing `moderators` or labeler trust settings on an already-populated database now requires a fresh database and backfill.
- Skip `runModerationCycle()` / `runPersistentModeration()` when no moderators, `subjects: "known"` labelers, or counted relations are configured.
