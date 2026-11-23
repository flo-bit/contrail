# Get started locally

Requires Node.js 22.15 or newer (Node 24 includes SQLite FTS5 for local full-text search).

## 1. Initialize an AppView

Import verified record Lexicons from your NSID prefix (include the trailing `.` for a namespace boundary):

```bash
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
cd my-appview
```

- `--prefix` selects the source record Lexicons to import from `https://lex.atmo.tools`.
- `--namespace` sets the XRPC namespace for generated AppView methods (defaults to `com.example`).
- Omit `--prefix` for an offline starter config with no network calls.

This creates `contrail.config.ts`, pins the imported Lexicons + dependency graph in `lexicons/pinned/`, and writes `lexicons/pinned.lock`. Commit all three. On an interactive TTY, Contrail prompts before wiring ambiguous `strongRef`/AT-URI references; pass `--no-interactive` to skip prompts.

| Flag | Purpose | Default |
| --- | --- | --- |
| `--prefix <prefix>` | Import record Lexicons matching this NSID prefix | none (offline starter) |
| `--namespace <nsid>` | XRPC namespace for generated methods | `com.example` |
| `--lexicon-api <url>` | Alternate Lexicon registry | `https://lex.atmo.tools` |
| `--timeout <seconds>` | Registry lookup budget | `60` |
| `--allow-partial` | Continue if prefix verification/indexing is incomplete | off |
| `--no-interactive` | Skip reference/relation prompts | off |

## 2. Run locally

```bash
pnpx @atmo-dev/contrail dev
```

Contrail creates a resumable SQLite database, backfills historical records from relays/PDSes, streams live Jetstream updates, and serves XRPC at `http://127.0.0.1:8787`:

```bash
curl 'http://127.0.0.1:8787/xrpc/com.example.calendar.event.listRecords?limit=10'
curl 'http://127.0.0.1:8787/status'
```

*(If you used the offline starter, the method is `com.example.event.listRecords`.)*

### Fast bootstrap with Alluvium

For non-Bluesky collections, load a pre-built snapshot from [Alluvium](https://backfill.atmo.tools) instead of crawling PDSes:

```bash
pnpx @atmo-dev/contrail dev --alluvium
```

Useful `dev` flags: `--temporary` (disposable DB), `--fresh` (wipe DB on start), `--no-backfill` (serve existing data only), `--port <n>`.

Next: [Add the typed client](./02-client.md).
