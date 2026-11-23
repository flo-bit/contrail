# Remote Cloudflare D1 backfill & upgrades

Practical guide for populating a remote Cloudflare D1 database and evolving config without hitting D1 CPU limits or accidentally writing to local `.wrangler/state`.

## Backfill a fresh remote D1 (recommended)

1. **Provision a new D1 database** (keep the old database intact for rollback, and keep private state like `REPORTS_DB` in a separate stable D1):

   ```bash
   pnpm wrangler d1 create my-appview-v2
   ```

2. **Point `wrangler.jsonc` at the new `database_id`** and choose a fresh `orderedSource.epoch` in `contrail.config.ts`. You do **not** need `"remote": true` or an `env.production` block in `wrangler.jsonc` — keep local dev local.

3. **Run the remote backfill:**

   ```bash
   # Fast path: stream public collections from Alluvium
   pnpm contrail backfill --remote --alluvium

   # Or PDS backfill (required for app.bsky.* or collections not on Alluvium)
   pnpm contrail backfill --remote
   ```

   Pass `--binding <NAME>` (default `DB`), `--env <NAME>` (when using Wrangler environments; note that named Wrangler environments do not inherit top-level `d1_databases` and must redeclare the binding), or `--wrangler-config <PATH>` as needed. `--remote` requires Wrangler `>= 4.37.0`, connects to the binding's real `database_id` (ignoring `preview_database_id`), and **fails closed** if Cloudflare auth or the remote D1 connection cannot be established. Keep live Workers and cron writers off the new database until the Alluvium bootstrap completes.

4. **Interrupted? Just re-run the same command.**
   - Alluvium loads in D1-safe batches (default `250` records, packed into compact `json_each(?)` bulk statements with zero pre-insert reads) and rebuilds FTS and relation counts in bounded keyset chunks (`500` rows per batch), persisting resume state atomically in `_contrail_meta`.
   - Resuming during the rebuild phase skips re-downloading the export and continues from the last committed FTS or count chunk.
   - An unfinished Alluvium bootstrap expires after 24 hours (`replayWindowUs`); after that, start on a fresh D1 database.

5. **Verify before cutover**, then stop old ingestion/cron writers, deploy the updated Worker, and confirm `/status` advances cleanly.

## Very large datasets (local SQLite → chunked SQL import)

Direct `--remote --alluvium` through Wrangler's remote binding proxy loads at ~650–700 records/s (one `db.batch()` round-trip per 250-record batch) and rebuilds FTS and relation counts at ~1,100 rows/s — so ~165k records with FTS and grouped relation counts finishes in ~8–9 minutes end-to-end (and resumes cleanly if interrupted).

For much larger datasets (millions of records) or heavy PDS rate-limit retries where remote round-trips are too slow, you can build locally with SQLite (`pnpm contrail backfill --sqlite ./candidate.sqlite --alluvium`) and import bounded SQL files with `wrangler d1 execute --remote`:

- **Never import one giant SQL dump** — large single files hit `D1_RESET_DO` and roll back.
- Split exports into ~10–12 MiB files with multi-row `INSERT`s capped at ~40 rows / ~48 KiB per statement, import sequentially, and verify row counts, FTS search, and cursor state before cutover.
- **D1 imports count as billable SQL reads/writes** (including index creation and FTS population).

## Changing config on an existing remote D1

- **Safe in-place changes:** Removing `feeds`, adding/removing other collections, or changing non-searchable query indexes does **not** rebuild existing collections' FTS tables or re-run one-time legacy `record_versions` migrations.
- **Expensive changes:** Editing `searchable` fields on a large collection rebuilds that collection's FTS table. Do this offline or onto a fresh D1 generation rather than letting a cold-start Worker request trigger it.
- **Never run old Contrail code against an upgraded database.** Roll back by pointing the old Worker at its previous database or backup.
