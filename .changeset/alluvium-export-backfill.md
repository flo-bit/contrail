---
"@atmo-dev/contrail": minor
---

Replace the Alluvium bootstrap adapter with one for the new export service.

`contrail backfill --alluvium` and `contrail dev --alluvium` now load a fresh generation from a single streamed export per bootstrap (default `https://backfill.atmo.tools`) and resume live ingestion from a timestamp cursor just before the export's snapshot, on whichever Jetstream service is configured. The service rebuilds its snapshot about hourly; an export from a snapshot more than six hours old is refused (`maxAgeUs`), as is one older than the snapshot the bootstrap began with. An interrupted bootstrap resumes where it stopped for up to 24 hours (`replayWindowUs`); after that live ingestion could no longer replay from its cursor, and it asks for a fresh database. Running either command again on a loaded database is a no-op, and `--only records` is accepted alongside `--alluvium`.

The SQLite paths (`--sqlite`, `contrail dev`) also drop the record tables' secondary indexes while loading and build them once at the end; A snapshot record can carry its own `timeUs`, which the Alluvium adapter sets, so each loaded record keeps the time it was written instead of the oldest time in its batch. `DatabaseBootstrapTarget` exposes the deferred indexes as `deferSecondaryIndexes` and the bootstrap helpers as `deferIndexes`. It is off for D1, where one statement cannot index a large table within its time limit.

Breaking, for the experimental `@atmo-dev/contrail/alluvium` entry point and CLI flags:

- The version-1 manifest protocol (bases, archive tails, checksummed objects) is no longer supported. `AlluviumCollectionManifest` and the related types are gone.
- `createAlluviumBootstrapSources` takes `{ endpoint?, source: { id, epoch }, token?, rewindUs?, maxAgeUs? }`. The `jetstream` option and `source.url` are removed.
- `bootstrapAlluvium` / `bootstrapAlluviumDatabase` no longer take `sourceUrl`, `retentionUs`, `watermarkCollections` or `allowPartial`; `sourceId` and `sourceEpoch` default to `config.orderedSource`. The result's `archiveBoundary` is now `handoff`, and it gains `alreadyComplete`.
- CLI: `--alluvium-source-id`, `--alluvium-source-url`, `--alluvium-epoch`, `--alluvium-retention-hours` and `--allow-partial` are removed; `--alluvium-token` is added (also read from `ALLUVIUM_TOKEN`).
- A local database bootstrapped by the previous adapter cannot be continued: `contrail dev --alluvium` no longer derives `orderedSource` from the Alluvium flags, so delete the old dev database (`.contrail/dev.sqlite`) and load it again.
