---
"@atmo-dev/contrail": patch
---

Reduce indexed profile hydration from eight sequential database reads to one joined read per 50 DIDs and profile collection. Include handles, current moderation visibility and cached profile misses in the same read. Preserve per-collection read-through for genuine misses and re-read indexed state after enrichment so concurrent hides, deletions and newer profile versions are respected.
