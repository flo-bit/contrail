---
"@atmo-dev/contrail-base": patch
"@atmo-dev/contrail-appview": patch
"@atmo-dev/contrail-record-host": patch
"@atmo-dev/contrail-lexicons": patch
---

Make NSID-keyed collections work through normal ingestion, not just FTS.

When a collection is keyed directly by its NSID (no short alias, `collection`
field omitted), the value defaulted to `undefined` everywhere it was read. The
records insert and FTS sync were patched via `resolveCollectionKey`, but the
real ingestion entry points still skipped these collections: `getCollectionNsids`
/ `getDiscoverableNsids` / `getDependentNsids` produced `undefined` NSIDs (so
Jetstream never subscribed and backfill never ran), `shortNameForNsid` returned
undefined (so `notify` rejected the URI as "collection not tracked"), and
`validateConfig` rejected the config outright (missing `collection`, dotted key
failing short-name validation).

`CollectionConfig.collection` is now optional. `resolveConfig` normalizes an
omitted `collection` to the map key, `validateConfig` accepts NSID-keyed entries,
and every collection-list / lookup helper resolves the NSID as `collection ?? key`
so the behavior is correct on both raw and resolved configs.
</content>
