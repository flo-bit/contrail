---
"@atmo-dev/contrail": minor
---

Remove the incomplete `refresh` PDS sweep from the public API, CLI, Wrangler helpers, examples, and documentation. Normal ingestion resumes from its saved source cursor; deployments whose source history has expired should rebuild into a fresh database rather than rely on partial reconciliation that cannot safely infer deletions.
