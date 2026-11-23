---
"@atmo-dev/contrail": patch
---

- Decouple per-collection FTS rebuilds (`fts_fingerprints`) and one-time v17 legacy migrations (`legacy_migrations_version`) from the global `schema_fingerprint` in `initSchema`, so unrelated config changes (such as removing `feeds`) do not rebuild unchanged FTS tables or rescan `record_versions` on cold start.
- Make Alluvium export backfills safe on remote Cloudflare D1: stop swallowing real FTS rebuild errors in `rebuildDerivedProjections` and `applyFtsTables` (ignoring only missing-FTS5-module errors), use D1-safe default batch sizing (`100`) and bounded resumable keyset-chunked FTS and relation-count rebuilds (`500` rows per batch) when `deferIndexes` is off, and emit periodic progress logs.
- Fix `contrail backfill --remote` and `contrail changes --remote` for Wrangler v4: resolve the target D1 binding's `database_id` from `wrangler.jsonc`/`wrangler.toml` (with optional `--env` and `--wrangler-config`, no hardcoded `"production"` env and no permanent `"remote": true` required), connect via an ephemeral remote proxy config, and fail closed instead of falling back to local `.wrangler/state`.
