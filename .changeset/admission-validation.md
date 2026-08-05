---
"@atmo-dev/contrail": minor
---

Add opt-in strict runtime Lexicon validation and canonical DAG-CBOR CID verification to the shared ingestion path. Route profile enrichment and Constellation follows through the same admission, source-ordering, projection, and sink behavior; expose bounded aggregate rejection diagnostics; and keep bulk backfill efficient by prefiltering out-of-scope dependencies, treating successful PDS pages as authoritative observations, and flushing diagnostics once per run.
