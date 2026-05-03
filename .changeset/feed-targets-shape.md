---
"@atmo-dev/contrail-lexicons": patch
---

Handle the new `FeedConfig.targets` shape (`string | { collection, maxItems? }`) when generating the feed lexicon and computing pull NSIDs.

When `FeedConfig.follow` is unset, mirror contrail's runtime default and emit `app.bsky.graph.follow` into the generated `lex.config.js` pull list — previously the auto-added follow collection was missing from `pull.sources[0].nsids`, so lex-cli wouldn't fetch its schema.
