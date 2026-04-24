# Lexicons

Contrail emits lexicon JSON for every XRPC method it exposes. Your app needs those files for two things: **generating typed TypeScript clients** and **publishing to a PDS** so other apps can discover your schemas. The `contrail-lex` CLI handles both.

```bash
pnpm add -D @atmo-dev/contrail-lexicons @atcute/lex-cli
```

`@atcute/lex-cli` is a peer dep — you pin the version.

## CLI

```bash
contrail-lex generate   # emit lexicon JSON from your Contrail config
contrail-lex pull       # wraps `lex-cli pull` (fetch external lexicons)
contrail-lex types      # wraps `lex-cli generate` (JSON → TS types)
contrail-lex all        # generate → pull → generate → pull → types
contrail-lex all --no-types    # same, skip the type step
contrail-lex publish    # publish lexicons to your PDS (add --dry-run to preview)
```

Config is auto-detected at `contrail.config.ts`, `src/contrail.config.ts`, `src/lib/contrail.config.ts`, or `app/contrail.config.ts`. Override with `--config <path>`.

## What lands where

Running `contrail-lex all` organises everything under one `lexicons/` directory:

```
lexicons/
  custom/               # hand-authored lexicons you write (optional)
  generated/            # JSON emitted from your Contrail config
  pulled/               # external NSIDs fetched by lex-cli pull
lex.config.js           # regenerated each run (gitignore)
src/lexicon-types/      # TS types from lex-cli generate
```

`lexicons/custom/`, `lexicons/generated/`, and `lexicons/pulled/` should be **committed** — that way CI doesn't need network access. `lex.config.js` and `src/lexicon-types/` are regenerated on demand and safe to gitignore.

## Publishing

Once your lexicons are generated and committed, publish them as `com.atproto.lexicon.schema` records on your PDS so other apps can resolve them:

```bash
contrail-lex publish <handle-or-did> <app-password>

# or via env vars (nicer for CI):
LEXICON_ACCOUNT_IDENTIFIER=you.bsky.social \
LEXICON_ACCOUNT_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  contrail-lex publish
```

Writes each lexicon to `at://<did>/com.atproto.lexicon.schema/<nsid>`. You'll also need DNS TXT records for your NSID authorities — the command prints the exact records you need and won't proceed until you confirm (override with `--skip-confirm` in CI).

Preview first with `--dry-run`:

```bash
contrail-lex publish --dry-run
```

Walks your `lexicons/generated/` dir, prints the NSIDs it would publish and the exact TXT records you'd need. Doesn't log in or write anything. Credentials aren't required for dry-run, so it's safe to run without secrets configured — useful for sanity-checking what a release would push.

**One-off flow:** generate once, commit, `contrail-lex publish --dry-run` to preview, `contrail-lex publish` once per version bump. You don't need to re-publish unless your lexicon JSON changes.

## Programmatic API

If you need to call the generator from code — e.g. to derive the XRPC method list for an OAuth permission set:

```ts
import { generateLexicons, extractXrpcMethods } from "@atmo-dev/contrail-lexicons";

const generated = generateLexicons({
  config,
  rootDir: process.cwd(),
  outputDir: "lexicons/generated",
});

const methods = extractXrpcMethods(generated); // every query + procedure NSID
```

`publishLexicons` is also exported for custom flows, but the CLI covers the common case.
