# Get started locally

Run a local AppView for a public AT Protocol collection with Node.js 22.13 or newer.

## Initialize from your Lexicon prefix

Pass the prefix to `contrail init`:

```bash
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
cd my-appview
```

Replace `community.lexicon.calendar.` with your source Lexicon prefix. The value
is matched as a literal NSID prefix, so include the trailing `.` when you mean a
namespace boundary. For example, this prefix selects record Lexicons such as
`community.lexicon.calendar.event` and
`community.lexicon.calendar.rsvp`.

The two namespace options serve different purposes:

- `--prefix` selects the record Lexicons Contrail imports.
- `--namespace` sets the generated AppView XRPC method namespace. It is optional,
  defaults to `com.example`, and does not need to match the imported prefix.

Omit `my-appview` to initialize the current directory. Contrail refuses to
replace an existing config or pinned import.

### What initialization creates

Contrail queries `https://lex.atmo.tools`, selects record Lexicons matching the
prefix, pins their complete dependency graph under `lexicons/pinned/`, and
creates `contrail.config.ts`. Every imported schema is recorded with its CID and
authority in `lexicons/pinned.lock`; commit the pinned schemas and lock alongside
the config.

String fields become equality filters and sort options; datetime fields become
range filters and chronological sort options. Arrays, unions, numeric fields,
and other unsupported shapes are reported rather than configured incorrectly.

When a strongRef or AT URI could point at another imported collection, an
interactive terminal asks whether to add forward hydration and an inverse
relation. The schema does not encode its target, so non-interactive runs leave
ambiguous references unconfigured. Use `--no-interactive` to request that
behavior explicitly.

### Import options

| Option | Purpose | Default |
|---|---|---|
| `--prefix <prefix>` | Import verified record Lexicons matching this NSID prefix | none (uses the offline starter) |
| `--namespace <namespace>` | Namespace for generated AppView XRPC methods | `com.example` |
| `--lexicon-api <url>` | Use another Lexicon registry | `https://lex.atmo.tools` |
| `--timeout <seconds>` | Readiness and dependency lookup budget | `60` |
| `--allow-partial` | Accept incomplete prefix verification or catalog indexing | off |
| `--no-interactive` | Skip reference and inverse-relation questions | off |

The default import requires complete verification and catalog indexing. Use
`--allow-partial` only when you deliberately accept that some prefix documents
may be absent; required dependencies must always resolve.

## Offline starter

For an example config with no registry request, omit `--prefix`:

```bash
pnpx @atmo-dev/contrail init my-appview
cd my-appview
```

## Run the local AppView

Then run:

```bash
pnpx @atmo-dev/contrail dev
```

Contrail resolves the Lexicons, backfills existing records, follows new records, and serves a resumable SQLite AppView at `http://127.0.0.1:8787`.

```bash
curl 'http://127.0.0.1:8787/xrpc/com.example.calendar.event.listRecords?limit=10'
```

If you used the offline starter instead, its method is
`com.example.event.listRecords`. Next: [add the typed client to your app](./02-client.md).
