---
"@atmo-dev/contrail-lexicons": patch
---

Include `app.bsky.graph.follow` in the generated `lex.config.js` pull list when a feed leaves `FeedConfig.follow` unset. Mirrors the runtime default that `resolveConfig` auto-adds, so `lex-cli pull` fetches the schema instead of skipping it.
