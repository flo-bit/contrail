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
GET https://<your-worker>.workers.dev/status
```

`/status` returns JSON with the live-ingest cursor, indexed record totals, discovery progress, known backfill work, and counts of pending or currently unreachable accounts.

## local dev

```bash
pnpm dev                # wraps wrangler dev + auto-fires cron + prompts for initial backfill
pnpm contrail backfill  # backfill against the local D1 created by wrangler
```

`pnpm dev` runs `contrail dev` under the hood. On start it inspects the local D1 and offers to start or resume backfill whenever known work remains, then runs `wrangler dev --test-scheduled` with a 60s timer hitting `/__scheduled` so the cron actually fires locally.

A failed PDS stays pending rather than being marked complete. The backfill command retries failures with a bounded attempt budget and exits unsuccessfully if work remains; rerun it later to give unreachable accounts a fresh retry budget.

```bash
curl http://localhost:8787/status
```

This reports the durable state without exposing account DIDs or raw upstream errors.

## extending

- **add a collection:** append to `collections` in `src/contrail.config.ts`; redeploy; `pnpm contrail backfill --remote` to backfill the new one.
- **add full-text search:** `searchable: ["field1", "field2"]`, redeploy, no backfill needed (fts indexes repopulate on ingest).
- **add relations / references:** see [indexing docs](../../docs/01-indexing.md).
