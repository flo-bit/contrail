# Cloudflare Workers + D1 example

Minimal standalone Contrail Worker indexing `community.lexicon.calendar.event`.

## Local dev

```bash
pnpm dev                # starts wrangler dev, triggers cron locally, offers backfill
pnpm contrail backfill  # manual PDS backfill into local D1
```

Fast bootstrap into a fresh local D1 via Alluvium:

```bash
rm -rf .wrangler/state
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

See [Configure and query](../../docs/03-configure-and-query.md) and [Deploy to Cloudflare Workers](../../docs/04-deploy-cloudflare.md).
