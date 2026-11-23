# Cloudflare Workers + D1 example

Minimal standalone Contrail Worker indexing `community.lexicon.calendar.event`.

## Local dev

```bash
pnpm dev                # starts wrangler dev, triggers cron locally, offers backfill
pnpm contrail backfill  # manual PDS backfill into local D1
```

Fast bootstrap into a fresh local D1 via Alluvium:

```bash
rm -rf .wrangler/state # destructive: local test data only
pnpm contrail backfill --alluvium
```

## Deploy

```bash
pnpm wrangler d1 create contrail   # copy database_id into wrangler.jsonc
pnpm wrangler deploy
pnpm contrail backfill --remote
```

Endpoints:

```bash
curl 'https://<your-worker>.workers.dev/xrpc/com.example.event.listRecords?startsAtMin=2026-01-01&limit=10'
curl 'https://<your-worker>.workers.dev/status'
```

`/status` reports the live cursor, record totals, discovery/backfill state, and `complete` / `pending` / `retrying` / `failed` account counts (without exposing DIDs or raw upstream errors). Failed PDS accounts retry automatically with backoff on the 1-minute cron (up to 10 scheduled attempts); rerunning `contrail backfill` resets exhausted rows.

See [Configure and query](../../docs/03-configure-and-query.md) and [Deploy guide](../../docs/04-deploy-cloudflare.md).
