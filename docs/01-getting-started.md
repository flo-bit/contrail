# Get started locally

Run a local AppView for a public AT Protocol collection with Node.js 22.13 or newer.

Create a project from a verified Lexicon namespace:

```bash
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
cd my-appview
```

Contrail queries `https://lex.atmo.tools`, selects record Lexicons under the
prefix, pins their complete dependency graph under `lexicons/pinned/`, and
creates `contrail.config.ts`. String fields become equality filters and sort
options; datetime fields become range filters and chronological sort options.
Arrays, unions, numeric fields, and other unsupported shapes are reported rather
than configured incorrectly.

When a strongRef or AT URI could point at another imported collection, an
interactive terminal asks whether to add forward hydration and an inverse
relation. The schema does not encode its target, so non-interactive runs leave
ambiguous references unconfigured. Use `--no-interactive` to request that
behavior explicitly.

The import requires complete verification and catalog indexing. Use
`--allow-partial` only when you deliberately accept that some prefix documents
may be absent; required dependencies must always resolve. Every imported schema
is recorded with its CID and authority in `lexicons/pinned.lock`.

For an offline example config with no registry request, omit `--prefix`:

```bash
pnpx @atmo-dev/contrail init my-appview
```

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
