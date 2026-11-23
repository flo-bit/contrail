# Contrail

> Pre-alpha. Expect breaking changes.

Contrail turns public AT Protocol records into a queryable AppView.

- Backfill from relays/PDSes or [Alluvium](https://backfill.atmo.tools) exports, then stream live updates from Jetstream
- Runs on Cloudflare Workers + D1, or Node.js + SQLite / PostgreSQL / PGlite
- Generates typed `getRecord` and `listRecords` XRPC endpoints with filters, range queries, sorting, full-text search, pagination, relation counts, hydration, and profile/label hydration

## Quick start

```bash
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
cd my-appview
pnpx @atmo-dev/contrail dev
```

`--prefix` imports your source record Lexicons; `--namespace` sets the XRPC namespace for the generated AppView methods.

## Docs

1. [Get started locally](docs/01-getting-started.md)
2. [Add the typed client](docs/02-client.md)
3. [Configure and query](docs/03-configure-and-query.md)
4. [Deploy to Cloudflare Workers & Node](docs/04-deploy-cloudflare.md)

**Advanced:** [Feeds](docs/advanced/feeds.md) · [Labels](docs/advanced/labels.md) · [Moderation](docs/advanced/moderation.md) · [Outbox](docs/advanced/outbox.md) · [Remote D1](docs/advanced/remote-d1.md)

**Examples:** [Cloudflare Workers + D1](apps/cloudflare-workers/README.md) · [Node + SQLite](apps/sqlite/README.md) · [Node + PostgreSQL](apps/postgres/README.md)

**Contributing:** [Development guide](development.md) · [Spaces alpha (workspace-private)](packages/contrail-spaces-alpha/README.md)
