---
"@atmo-dev/contrail-lexicons": patch
---

fix: resolve `feeds[*].follow` short names to NSIDs when emitting `lex.config.js`. previously the generator pushed the raw short name (e.g. `"follow"`) into `pull.sources[0].nsids`, causing `lex-cli pull` to fail with `ValitaError: must be valid nsid`. now matches the existing `collections` / `profiles` resolution path; feeds pointing at unknown collections are skipped instead of leaking `undefined`.
