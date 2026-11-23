---
"@atmo-dev/contrail": minor
---

Remove the `contrail init --prefix` Lexicon registry wizard and the `contrail connect` consumer lockfile/scaffolding CLI command.

- `contrail init [dir]` remains as a lightweight offline starter-config generator (`contrail.config.ts`).
- Use `contrail lexicons all` and `@atmo-dev/contrail/client` (`createPublicServiceClient`) for typed XRPC clients.
