---
"@atmo-dev/contrail": minor
---

Remove the `contrail init --prefix` Lexicon registry wizard and the `contrail connect` consumer lockfile/scaffolding CLI command.

- `contrail init [dir]` remains as a lightweight offline starter-config generator (`contrail.config.ts`).
- Projects that previously ran `contrail connect` can run `contrail lexicons all --config <path>` when `contrail.config.ts` is available locally, or fetch `/.well-known/contrail` and its `lexicons.url` bundle and run `@atcute/lex-cli generate` with `@atmo-dev/contrail/client` (`createPublicServiceClient`; see `docs/02-client.md`).
