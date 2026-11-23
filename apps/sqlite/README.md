# Node.js + SQLite example

Minimal local Contrail AppView backed by `node:sqlite`, bootstrapped from Alluvium.

## Run

```bash
pnpm dev     # bootstraps ./data/contrail.sqlite from Alluvium, runs live ingest, serves on :8787
pnpm status  # print cursor, counts, and bootstrap status JSON
pnpm ingest  # run one catch-up ingest cycle without starting the HTTP server
```

To use PDS backfill instead of Alluvium:

```bash
pnpm contrail backfill
```

To start completely fresh:

```bash
rm -f data/contrail.sqlite*
```
