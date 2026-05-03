import type { BlobAdapter, RecordHost } from "@atmo-dev/contrail-base";
import { blobKey } from "@atmo-dev/contrail-base";

export interface BlobGcOptions {
  /** Orphan rows created before this timestamp are eligible for deletion. */
  olderThan: number;
  /** Maximum number of blobs to delete in this pass. Defaults to 500. */
  batchSize?: number;
}

export interface BlobGcResult {
  deleted: number;
  cids: string[];
}

/** Delete blob bytes + metadata for any blob older than `olderThan` that
 *  is not referenced by any record in the space. Safe to run periodically. */
export async function gcOrphanBlobs(
  storage: RecordHost,
  blobs: BlobAdapter,
  spaceUri: string,
  options: BlobGcOptions
): Promise<BlobGcResult> {
  const batchSize = options.batchSize ?? 500;
  const orphans = await storage.findOrphanBlobs(spaceUri, options.olderThan, batchSize);
  if (orphans.length === 0) return { deleted: 0, cids: [] };

  const keys: string[] = [];
  for (const row of orphans) {
    keys.push(await blobKey(row.spaceUri, row.cid));
  }
  await blobs.delete(keys);
  for (const row of orphans) {
    await storage.deleteBlobMeta(row.spaceUri, row.cid);
  }
  return { deleted: orphans.length, cids: orphans.map((o) => o.cid) };
}
