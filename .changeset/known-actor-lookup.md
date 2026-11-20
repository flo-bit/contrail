---
"@atmo-dev/contrail": patch
---

Scheduled ingestion no longer scans the whole index for known accounts on every run. It now looks up only the accounts that appear in the events it is reading, so the rows it reads follow event volume, not index size. On Cloudflare Workers, where nearly every scheduled run starts in a new isolate, the old scan read every record table once a minute.
