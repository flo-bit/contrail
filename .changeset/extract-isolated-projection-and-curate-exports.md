---
"@atmo-dev/contrail": minor
---

Move the experimental Spaces `isolated-projection` engine out of core `@atmo-dev/contrail` into the workspace-private `@atmo-dev/contrail-spaces-alpha` package, and replace wildcard `export *` re-exports in `@atmo-dev/contrail`'s root entrypoint with a curated explicit public API.

- Removes ~170 internal-only root exports (DDL builders, migration keys, route registrars, metadata/feed-prune/moderation internals); the package `exports` map continues to block deep imports.
- All symbols and referenced types used by the documented public API and downstream apps remain exported from `@atmo-dev/contrail`.
