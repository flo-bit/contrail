/** Centralized space URI construction / parsing.
 *
 *  Permissioned spaces are addressed by (ownerDid, type, key). The rough spec
 *  (https://dholms.leaflet.pub/3mhj6bcqats2o) floats `ats://` as a likely
 *  distinct scheme for permissioned data, but that's unresolved — we keep
 *  `at://` today and isolate the format here so swapping is a one-liner.
 *
 *  Record URIs inside a space are minted by authorDid for index purposes
 *  (`at://<authorDid>/<collection>/<rkey>`); the spec is explicitly undecided
 *  about authority (user vs space owner), so we don't expose those as a
 *  canonical record address — they're storage-internal. */

export interface SpaceUriParts {
  ownerDid: string;
  type: string;
  key: string;
}

/** Build a space URI from its three addressing components. */
export function buildSpaceUri(parts: SpaceUriParts): string {
  return `at://${parts.ownerDid}/${parts.type}/${parts.key}`;
}

/** Parse a space URI into its components, or null if malformed. */
export function parseSpaceUri(uri: string): SpaceUriParts | null {
  if (!uri.startsWith("at://")) return null;
  const rest = uri.slice("at://".length);
  const [ownerDid, type, key, ...extra] = rest.split("/");
  if (!ownerDid || !type || !key || extra.length > 0) return null;
  return { ownerDid, type, key };
}

/** Build a record URI under a given author. Used only as a secondary index key
 *  inside storage — not a canonical address for permissioned records. */
export function buildRecordUri(authorDid: string, collection: string, rkey: string): string {
  return `at://${authorDid}/${collection}/${rkey}`;
}
