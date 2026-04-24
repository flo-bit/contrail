/**
 * Walk a record JSON and collect every atproto blob ref.
 *
 * Blob refs look like:
 *   { "$type": "blob", "ref": { "$link": "<cid>" }, "mimeType": "...", "size": N }
 *
 * We return the CID strings.
 */
export function collectBlobCids(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const v of value) collectBlobCids(v, out);
    return out;
  }
  if (typeof value !== "object") return out;

  const obj = value as Record<string, unknown>;
  if (obj["$type"] === "blob") {
    const ref = obj["ref"] as { $link?: unknown } | undefined;
    if (ref && typeof ref["$link"] === "string") out.add(ref["$link"]);
    // Don't descend — a blob ref's own shape has no nested blobs.
    return out;
  }

  for (const v of Object.values(obj)) collectBlobCids(v, out);
  return out;
}
