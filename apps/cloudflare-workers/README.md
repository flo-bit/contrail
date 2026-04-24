# cloudflare-workers

minimal, runnable contrail deployment — cloudflare workers + d1, one collection (`community.lexicon.calendar.event`), no spaces / communities / realtime. mirrors the setup shown in the [root README](../../README.md) exactly.

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
pnpm deploy                              # deploy the worker
pnpm contrail backfill --remote          # discover + backfill historical events
```

then hit:

```
GET https://<your-worker>.workers.dev/xrpc/com.example.event.listRecords?startsAtMin=2026-01-01&limit=10
```

## local dev

```bash
pnpm dev                # wrangler dev, cron fires every minute
pnpm contrail backfill  # backfill against the local D1 created by wrangler
```

## extending

- **add a collection:** append to `collections` in `src/contrail.config.ts`; redeploy; `pnpm contrail backfill --remote` to backfill the new one.
- **add full-text search:** `searchable: ["field1", "field2"]`, redeploy, no backfill needed (fts indexes repopulate on ingest).
- **add relations / references:** see [indexing docs](../../docs/01-indexing.md).
- **private records:** see [spaces docs](../../docs/04-spaces.md).
- **group-controlled DIDs:** see [communities docs](../../docs/05-communities.md).
