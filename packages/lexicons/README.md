# @atmo-dev/contrail-lexicons

Generate atproto lexicon JSON from a [contrail](https://www.npmjs.com/package/@atmo-dev/contrail) config, and (optionally) drive the full `@atcute/lex-cli` pull + type-generation pipeline from a single command.

## Install

```bash
pnpm add -D @atmo-dev/contrail-lexicons @atcute/lex-cli
```

`@atcute/lex-cli` is a peer dep — you pin the version.

## CLI

```bash
contrail-lex generate   # emit lexicon JSON from your Contrail config
contrail-lex pull       # wraps `lex-cli pull`
contrail-lex types      # wraps `lex-cli generate`
contrail-lex all        # generate → pull → generate → pull → types
contrail-lex all --no-types   # skip the final type-generation step
```

The CLI auto-detects your Contrail config at `contrail.config.ts`, `app/config.ts`, or `src/lib/contrail/config.ts` (first match wins). Override with `--config <path>`.

For anything the `all` subcommand doesn't cover — custom output dirs, extra pull sources, multiple `lex.config.js` files — call `lex-cli` directly. This package doesn't hide or replace it.

## Programmatic API

```ts
import { generateLexicons } from "@atmo-dev/contrail-lexicons";

const generated = generateLexicons({
  config,
  rootDir: process.cwd(),
  outputDir: "lexicons-generated",
});
```

See also: `extractXrpcMethods`, `listXrpcMethods`, `publishLexicons`.
