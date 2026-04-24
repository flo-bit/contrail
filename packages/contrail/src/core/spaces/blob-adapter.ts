/**
 * Bytes-only storage adapter for space blobs. Metadata (CID, mime, size,
 * author, space) lives in the `spaces_blobs` table on the main StorageAdapter;
 * this interface only moves bytes in and out of a backend (R2, S3, fs, …).
 *
 * Keys are opaque strings formed by the router as `blobKey(spaceUri, cid)`.
 */

export interface BlobUploadMeta {
  mimeType: string;
  size: number;
}

export interface BlobAdapter {
  put(key: string, bytes: Uint8Array, meta: BlobUploadMeta): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Bulk delete. Adapters that don't support batch can implement serially. */
  delete(keys: string[]): Promise<void>;
}

/** In-memory adapter. Useful for tests and local development. */
export class MemoryBlobAdapter implements BlobAdapter {
  private readonly store = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.store.set(key, bytes.slice());
  }

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.store.get(key);
    return v ? v.slice() : null;
  }

  async delete(keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  /** Test helper. */
  size(): number {
    return this.store.size;
  }
}

/** Minimal Cloudflare R2 bucket shape — matches @cloudflare/workers-types' R2Bucket
 *  without forcing a types dependency here. */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | Blob,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** Cloudflare R2 adapter. Pass the `env.BLOBS` binding from your Worker. */
export class R2BlobAdapter implements BlobAdapter {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, bytes: Uint8Array, meta: BlobUploadMeta): Promise<void> {
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: meta.mimeType },
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.bucket.delete(keys);
  }
}

/** Hash a space URI to a short, filesystem/R2-safe key segment.
 *  Used as the first segment of a blob key so all blobs for one space
 *  share a common prefix (enables bulk delete on space deletion). */
export async function spaceKeyPrefix(spaceUri: string): Promise<string> {
  const bytes = new TextEncoder().encode(spaceUri);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}

/** Compose an adapter key from a space URI and CID.
 *  Shape: `<16-hex-chars-of-sha256(spaceUri)>/<cid>`. */
export async function blobKey(spaceUri: string, cid: string): Promise<string> {
  const prefix = await spaceKeyPrefix(spaceUri);
  return `${prefix}/${cid}`;
}
