# Node.js + PostgreSQL example

Minimal Contrail AppView backed by PostgreSQL (`pg`) with persistent Jetstream ingestion.

## Setup

Start PostgreSQL (Docker on port `5433`, or set `DATABASE_URL` to your own instance):

```bash
docker compose up -d
```

Edit `contrail.config.ts` to customize collections.

## Run

```bash
pnpm sync    # discover repos and backfill historical records
pnpm ingest  # long-lived Jetstream listener
pnpm serve   # HTTP XRPC server (default http://localhost:3000)
```

Verify:

```bash
curl 'http://localhost:3000/xrpc/rsvp.atmo.event.listRecords?limit=10'
curl 'http://localhost:3000/health'
```
