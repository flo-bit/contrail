---
"@atmo-dev/contrail": patch
---

Replace SQLite and D1 full-text-search URI scans with an ordinary unique URI-to-rowid mapping and direct FTS5 rowid mutations. Existing URI-bearing FTS tables are rebuilt transactionally from canonical records, stale-fingerprint projections are rebuilt and verified before acceptance, duplicate search rows are removed, and incremental/rebuild whitespace normalization now agrees. PostgreSQL search remains unchanged.
