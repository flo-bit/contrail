---
"@atmo-dev/contrail-lexicons": patch
---

Handle the new `FeedConfig.targets` shape (`string | { collection, maxItems? }`) when generating the feed lexicon and computing pull NSIDs, and fall back to the default `"follow"` short name when `FeedConfig.follow` is unset.
