# Get started locally

Requires Node.js 22.15 or newer (Node 24 includes SQLite FTS5 for local full-text search).

## 1. Initialize an AppView

Create a starter `contrail.config.ts`:

```bash
pnpx @atmo-dev/contrail init my-appview
cd my-appview
```

Edit `contrail.config.ts` to set your XRPC `namespace` and the collections, queryable fields, relations, and search fields you want to index.

## 2. Run locally

```bash
pnpx @atmo-dev/contrail dev
```

Contrail creates a resumable SQLite database, backfills historical records from relays/PDSes, streams live Jetstream updates, and serves XRPC at `http://127.0.0.1:8787`:

```bash
curl 'http://127.0.0.1:8787/xrpc/com.example.event.listRecords?limit=10'
curl 'http://127.0.0.1:8787/status'
```

### Fast bootstrap with Alluvium

For non-Bluesky collections, load a pre-built snapshot from [Alluvium](https://backfill.atmo.tools) instead of crawling PDSes:

```bash
pnpx @atmo-dev/contrail dev --alluvium
```

Useful `dev` flags: `--temporary` (disposable DB), `--fresh` (wipe DB on start), `--no-backfill` (serve existing data only), `--port <n>`.

Next: [Add the typed client](./02-client.md).
