---
"@atmo-dev/contrail-appview": patch
"@atmo-dev/contrail-base": patch
---

Stop running the `feed_items` prune sweep on every ingest tick.

A feed only exceeds its cap right after a feed-mutating record, so the per-tick sweep was a no-op on the vast majority of ticks yet still issued a cutoff `DELETE` per actor (~98% of all D1 queries on one deployment). It now sweeps only when a feed-mutating collection was ingested, plus a recovery pass that becomes due ~6h after the previous one completed and then laps one slice per tick — including on idle persistent streams and the `notifyOfUpdate` path. New `getFeedMutatingNsids(config)` derives the gating set. See `docs/04-feeds.md` for sweep timing (and why the full-pass cadence is interval + lap time, not a hard 6h) and the fan-out promptness trade-off.
