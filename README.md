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

## Documentation

1. [Get started locally](docs/00-getting-started.md)
2. [Add the typed client](docs/01-client.md)
3. [Configure and query](docs/02-configure-and-query.md)
4. [Deploy to Cloudflare Workers](docs/03-deploy-cloudflare.md)
