---
"@atmo-dev/contrail": patch
---

Scheduled ingestion no longer scans the whole index for known accounts on every run. It now looks up only the accounts that write to known-accounts-only collections (profiles, follows) in the events it is reading, up to 500 per query, so the rows it reads follow the number of accounts seen on the network, not index size. On Cloudflare Workers, where nearly every scheduled run starts in a new isolate, the old scan read every record table once a minute.

A new `maxActorLookups` ingest option (default 20) caps those queries per run. A run that reaches it stops with `stop_reason: "actor-lookups"` and the next run continues from there.

Scheduled backfill retries (`retryBackfill`) no longer read the whole `backfills` table on every run: a new index covers only unfinished work, and the account list is loaded only when something is due. The index is added on the next `init` without rebuilding anything.
