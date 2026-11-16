---
"@atmo-dev/contrail": minor
---

Replace the Alluvium bootstrap adapter with one for the new export service.

`contrail backfill --alluvium` and `contrail dev --alluvium` now load a fresh generation from a single streamed export per bootstrap (default `https://backfill.atmo.tools`) and resume live ingestion from a timestamp cursor just before the export's head, on whichever Jetstream service is configured.

Breaking, for the experimental `@atmo-dev/contrail/alluvium` entry point and CLI flags:

- The version-1 manifest protocol (bases, archive tails, checksummed objects) is no longer supported. `AlluviumCollectionManifest` and the related types are gone.
- `createAlluviumBootstrapSources` takes `{ endpoint?, source: { id, epoch }, token?, rewindUs? }`. The `jetstream` option and `source.url` are removed.
- `bootstrapAlluvium` / `bootstrapAlluviumDatabase` no longer take `sourceUrl`, `retentionUs`, `watermarkCollections` or `allowPartial`; `sourceId` and `sourceEpoch` default to `config.orderedSource`. The result's `archiveBoundary` is now `handoff`.
- CLI: `--alluvium-source-id`, `--alluvium-source-url`, `--alluvium-epoch`, `--alluvium-retention-hours` and `--allow-partial` are removed; `--alluvium-token` is added.
