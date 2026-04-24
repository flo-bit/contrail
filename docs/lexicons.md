# Lexicons

Contrail emits lexicon JSON for every XRPC method it exposes. Your app needs those JSON files for two things: publishing to your PDS (so other apps can discover them) and generating TypeScript types for typed clients. The `contrail-lex` CLI handles both.

```bash
pnpm add -D @atmo-dev/contrail-lexicons @atcute/lex-cli
```

`@atcute/lex-cli` is a peer dep — you pin the version.

## CLI

```bash
contrail-lex generate   # emit lexicon JSON from your Contrail config
contrail-lex pull       # wraps `lex-cli pull` (fetches external lexicons)
contrail-lex types      # wraps `lex-cli generate` (JSON → TS types)
contrail-lex all        # generate → pull → generate → pull → types
contrail-lex all --no-types   # skip the type step
```

The CLI auto-detects your config at `contrail.config.ts`, `app/config.ts`, or `src/lib/contrail/config.ts`. Override with `--config <path>`.

## What lands where

Running `contrail-lex all` against a config with `namespace: "com.example"` writes:

```
lexicons-generated/     # JSON lexicons emitted from your config
lexicons-pulled/        # external NSIDs fetched by lex-cli pull
lex.config.js           # regenerated each run (add to .gitignore)
src/lexicon-types/      # TS types emitted by lex-cli generate
```

`lexicons-generated/` and `lexicons-pulled/` should be **committed** — that way CI doesn't need network access and consumers of your repo can pull the JSON as a lexicon source. `lex.config.js` and `src/lexicon-types/` are generated on demand and safe to gitignore.

## Publishing to a PDS

Once committed, publish the lexicons to an atproto account so other apps can resolve them:

```ts
import { publishLexicons } from "@atmo-dev/contrail-lexicons";

await publishLexicons({
  generatedDir: "lexicons-generated",
  identifier: process.env.LEXICON_ACCOUNT_IDENTIFIER,
  password: process.env.LEXICON_ACCOUNT_PASSWORD,
});
```

Writes each lexicon as a `com.atproto.lexicon.schema` record under `at://<did>/com.atproto.lexicon.schema/<nsid>`. You'll also need DNS TXT records — publishing prints them for you.

## Programmatic API

```ts
import { generateLexicons, extractXrpcMethods } from "@atmo-dev/contrail-lexicons";

const generated = generateLexicons({
  config,
  rootDir: process.cwd(),
  outputDir: "lexicons-generated",
});

const methods = extractXrpcMethods(generated); // NSIDs of every query + procedure
```

Handy for emitting the method list for your OAuth permission set.

## Consuming a third-party contrail instance

Someone else runs a contrail deployment; you want typed client access to their XRPCs. Point `lex-cli pull` at their git repo:

```js
// lex.config.js
import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  outdir: "src/lexicon-types/",
  imports: ["@atcute/atproto"],
  files: ["lexicons/**/*.json"],
  pull: {
    outdir: "lexicons/",
    sources: [{
      type: "git",
      remote: "https://github.com/them/their-contrail.git",
      pattern: ["lexicons-generated/**/*.json"],
    }],
  },
});
```

Then `npx lex-cli pull && npx lex-cli generate`, and their endpoints are typed in your client.
