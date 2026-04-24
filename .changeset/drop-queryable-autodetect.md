---
"@atmo-dev/contrail-lexicons": patch
---

the lexicon generator previously auto-detected queryable fields by walking the pulled record schema (string → equality, datetime → range, etc.) and merged them with the user's explicit `queryable` before emitting `listRecords.json`.

problem: the runtime does **not** auto-detect — it only honors fields explicitly declared in `colConfig.queryable`. So the generated lexicon advertised filter params (e.g. `?mode=online`, `?status=going`) that the server silently ignored. Clients would pass them and get unfiltered results back.

fix: the generator now only emits what the user declared. the lexicon matches the runtime. one source of truth.

if you were relying on the phantom params, add the fields explicitly to your config's `queryable` map. if you weren't, nothing changes except smaller, more honest `listRecords.json` files on the next `contrail-lex generate` run.
