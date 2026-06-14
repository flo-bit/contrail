---
"@atmo-dev/contrail-base": patch
"@atmo-dev/contrail-appview": patch
---

Populate FTS and detect existing records for NSID-keyed collections.

When a collection is keyed directly by its NSID (no short alias / `collection`
field), `shortNameForNsid` returns undefined, so the FTS-sync and
existing-record-lookup paths silently skipped it. Only the records insert had
the NSID fallback, leaving full-text search empty and replay/update detection
broken for those collections. Added a `resolveCollectionKey` helper that returns
the storage key (alias or NSID) and used it at all three sites.
