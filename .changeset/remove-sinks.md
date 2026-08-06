---
"@atmo-dev/contrail": patch
---

Remove the best-effort post-commit sink API. Contrail now limits core ingestion to transactional SQL projection instead of invoking external callbacks after live or historical commits.
