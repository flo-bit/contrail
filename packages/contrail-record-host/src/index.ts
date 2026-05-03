/** @atmo-dev/contrail-record-host — default record-host implementation.
 *
 *  Owns the host-side adapter (records, blobs, enrollment) + DDL + blob-GC.
 *  Independent of the authority — takes a Database directly, doesn't inherit
 *  from anything. Bundles can instantiate this alongside HostedAuthorityAdapter
 *  against the same DB to get full StorageAdapter behavior. */

export {
  HostedRecordHostAdapter,
  mapBlobMetaRow,
  mapEnrollmentRow,
  mapRecordRow,
} from "./adapter";

export {
  buildRecordHostBaseSchema,
  applyRecordHostSchema,
} from "./schema";

export {
  gcOrphanBlobs,
} from "./blob-gc";
export type { BlobGcOptions, BlobGcResult } from "./blob-gc";

export { collectBlobCids } from "./blob-refs";

export { registerRecordHostRoutes } from "./routes";

export { registerRecordHostSyncRoutes } from "./sync";
export type { RecordHostSyncOptions, SyncEvent } from "./sync";
