---
"@atmo-dev/contrail": minor
---

Remove unused Phase-3 fresh-generation scaffolding (`generations`, `pds-snapshot`, `jetstream-source`, `jetstreamUrlOption`) and drop the unused `@atproto/lex` and `@atcute/jetstream` runtime dependencies.

Collapse the generic multi-provider bootstrap layer (`sources`, `bootstrap`, `verification`, `AlluviumChangeSource`, and global `bootstrap_state` / `bootstrap_snapshot_progress` tables) into a direct resumable Alluvium export loader (`loadAlluviumExport`, `getAlluviumBootstrapState`) in `@atmo-dev/contrail/alluvium`. The separate post-load `verifyBootstrapCandidate` / `getBootstrapVerification` integrity gate was removed alongside `verification`.

`contrail backfill --alluvium`, `contrail dev --alluvium`, `bootstrapAlluvium`, and `bootstrapAlluviumDatabase` now store resume state in `_contrail_meta`. Existing databases retain any legacy `bootstrap_state` / `bootstrap_snapshot_progress` tables harmlessly, and databases whose Alluvium bootstrap completed on an earlier version are still recognized as complete on restart (any interrupted pre-0.32 bootstrap must be discarded and started fresh).
