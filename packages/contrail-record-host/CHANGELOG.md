# @atmo-dev/contrail-record-host

## 0.12.1

### Patch Changes

- 74a2d3d: Make NSID-keyed collections work through normal ingestion, not just FTS.

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

- Updated dependencies [833a659]
- Updated dependencies [74a2d3d]
- Updated dependencies [9894787]
  - @atmo-dev/contrail-base@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [6b34d87]
  - @atmo-dev/contrail-base@0.12.0

## 0.11.0

### Patch Changes

- @atmo-dev/contrail-base@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [89aee1b]
  - @atmo-dev/contrail-base@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [4c8fedb]
  - @atmo-dev/contrail-base@0.9.1

## 0.9.0

### Patch Changes

- @atmo-dev/contrail-base@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [d7e0936]
  - @atmo-dev/contrail-base@0.8.0

## 0.7.0

### Patch Changes

- @atmo-dev/contrail-base@0.7.0
