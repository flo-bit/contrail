---
"@atmo-dev/contrail": minor
---

Remove unused Phase-3 fresh-generation scaffolding (`generations`, `pds-snapshot`, `jetstream-source`, `jetstreamUrlOption`) and drop the unused `@atproto/lex` and `@atcute/jetstream` runtime dependencies.

Collapse the generic multi-provider bootstrap layer (`sources`, `bootstrap`, `verification`, `AlluviumChangeSource`, and global `bootstrap_state` / `bootstrap_snapshot_progress` tables) into a direct resumable Alluvium export loader (`loadAlluviumExport`, `getAlluviumBootstrapState`) in `@atmo-dev/contrail/alluvium`. `contrail backfill --alluvium`, `contrail dev --alluvium`, `bootstrapAlluvium`, and `bootstrapAlluviumDatabase` retain their behavior while storing resume state in `_contrail_meta`.
