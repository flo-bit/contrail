---
"@atmo-dev/contrail": patch
---

Scheduled ingestion no longer scans the whole index for known accounts on every run. It now looks up only the accounts that appear in the events it is reading, so the rows it reads follow event volume, not index size. On Cloudflare Workers, where nearly every scheduled run starts in a new isolate, the old scan read every record table once a minute.

Scheduled backfill retries (`retryBackfill`) no longer read the whole `backfills` table on every run: a new index covers only unfinished work, and the account list is loaded only when something is due. The index is added on the next `init` without rebuilding anything.
