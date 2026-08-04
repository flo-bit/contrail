# cloudflare-workers

Minimal runnable Contrail deployment: Cloudflare Workers, D1, and one public collection (`community.lexicon.calendar.event`). It mirrors the setup in the [root README](../../README.md).

## layout

```
src/contrail.config.ts   — shared config (collections, queryables, searchables)
src/worker.ts            — fetch handler + scheduled ingest
wrangler.jsonc           — d1 binding + cron
```

backfills run via the `contrail` cli from the library (see `package.json` scripts) — no script file needed.

## setup

```bash
pnpm install
npx wrangler d1 create contrail          # copy database_id into wrangler.jsonc
pnpm contrail backfill --remote          # discover + backfill historical events
pnpm deploy                              # deploy the worker
```

then hit:

```
GET https://<your-worker>.workers.dev/xrpc/com.example.event.listRecords?startsAtMin=2026-01-01&limit=10
```

## local dev

```bash
pnpm dev                # wraps wrangler dev + auto-fires cron + prompts for backfill/refresh if needed
pnpm contrail backfill  # backfill against the local D1 created by wrangler
```

`pnpm dev` runs `contrail dev` under the hood. On start it inspects the local D1 and prompts to run backfill (if nothing's indexed yet) or refresh (if the ingest cursor is >1h old), then runs `wrangler dev --test-scheduled` with a 60s timer hitting `/__scheduled` so the cron actually fires locally.

## extending

- **add a collection:** append to `collections` in `src/contrail.config.ts`; redeploy; `pnpm contrail backfill --remote` to backfill the new one.
- **add full-text search:** `searchable: ["field1", "field2"]`, redeploy, no backfill needed (fts indexes repopulate on ingest).
- **add relations / references:** see [indexing docs](../../docs/01-indexing.md).
