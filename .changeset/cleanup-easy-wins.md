---
"@atmo-dev/contrail": minor
---

Slim moderation, labels, Jetstream live ingest, Lexicon generation, and Alluvium bootstrap:

- **Moderation & labels:** Remove moderator `override` actions, `moderation_overrides`, `starts_at` delayed-expiry scheduling, `label_backfill_sources`, and `loadReportInboxes` from `@atmo-dev/contrail/moderation` (keeping report & action helpers). Simplify `reconcileModeratorActions` to a stateless bounded PDS diff/sync and collapse `core/labels/` from 9 files to 3 (`index.ts`, `apply.ts`, `subscribe.ts`). Existing databases upgrade cleanly without rebuilding FTS or reseeding `record_versions`.
- **Jetstream live ingest:** Remove the dead v1 `cursor_observations` table and per-commit `DELETE`, drop unused `cursorBoundaryDuplicatesDropped` and `core/runtime-telemetry.ts`, and share live-ingest session/account helpers between `jetstream.ts` and `persistent.ts`.
- **Lexicons & CLI:** Stop generating `lex.config.js` (keep `--no-atcute-config` accepted as a no-op), remove `contrail lexicons all|pull|types` and the `contrail dev` auto-pull loop, diff `checkLexicons()` in memory, and remove `@atcute/lex-cli` and `@atcute/uint8array` from runtime `dependencies`.
- **Alluvium & schema:** Remove legacy pre-v0.32 `bootstrap_state` fallback and unreachable legacy fingerprint branches; skip redundant Postgres `ALTER TABLE ... search_vector` DDL when `fts_fingerprints` is already current.
