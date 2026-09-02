# Contrail

> **Pre-alpha.** Expect breaking changes.

Contrail turns public AT Protocol records into a queryable AppView.

It provides:

- historical backfill from relays and PDSes;
- current updates from Jetstream;
- D1, SQLite, and PostgreSQL storage;
- `getRecord` and `listRecords` HTTP endpoints;
- filters, sorting, search, and pagination;
- custom queries;
- relationship counts and hydration; and
- profile and label hydration.

Cloudflare Workers with D1 is the primary deployment target. Node.js with SQLite or PostgreSQL is also supported.

## Quick start from a Lexicon prefix

```bash
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
cd my-appview
pnpx @atmo-dev/contrail dev
```

`--prefix` selects the source record Lexicons to import; `--namespace` sets the
separate XRPC namespace for the generated AppView methods. See the
[prefix setup guide](docs/01-getting-started.md#initialize-from-your-lexicon-prefix)
for choosing a prefix, generated files, and import options.

## Documentation

1. [Get started locally](docs/01-getting-started.md)
2. [Add the typed client](docs/02-client.md)
3. [Configure and query](docs/03-configure-and-query.md)
4. [Deploy to Cloudflare Workers](docs/04-deploy-cloudflare.md)
