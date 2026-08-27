const DID = "did:[a-z0-9]+:[A-Za-z0-9._:%-]+";
const NSID = "[A-Za-z][A-Za-z0-9.-]*[A-Za-z0-9]";
const RKEY = "[A-Za-z0-9._~:-]+";
const SPACE_PATTERN = new RegExp(
  `^at://(${DID})/space/(${NSID})/(${RKEY})$`,
);

export interface ParsedSpaceUri {
  uri: string;
  authorityDid: string;
  type: string;
  skey: string;
}

export interface ParsedSpaceRecordUri extends ParsedSpaceUri {
  spaceUri: string;
  writerDid: string;
  collection: string;
  rkey: string;
}

export function parseSpaceUri(value: unknown): ParsedSpaceUri {
  if (typeof value !== "string") throw new TypeError("Space URI must be a string");
  const match = SPACE_PATTERN.exec(value);
  if (!match) throw new TypeError(`Invalid Space URI: ${value}`);
  return {
    uri: value,
    authorityDid: match[1],
    type: match[2],
    skey: match[3],
  };
}

export function formatSpaceUri(input: {
  authorityDid: string;
  type: string;
  skey: string;
}): string {
  return parseSpaceUri(
    `at://${input.authorityDid}/space/${input.type}/${input.skey}`,
  ).uri;
}

export function parseSpaceRecordUri(value: unknown): ParsedSpaceRecordUri {
  if (typeof value !== "string") {
    throw new TypeError("Space record URI must be a string");
  }
  const parts = value.split("/");
  // at: // authority space type skey writer collection rkey
  if (parts.length !== 9 || parts[3] !== "space") {
    throw new TypeError(`Invalid Space record URI: ${value}`);
  }
  const spaceUri = parts.slice(0, 6).join("/");
  const space = parseSpaceUri(spaceUri);
  const writerDid = parts[6];
  const collection = parts[7];
  const rkey = parts[8];
  if (!new RegExp(`^${DID}$`).test(writerDid)) {
    throw new TypeError(`Invalid Space record writer: ${writerDid}`);
  }
  if (!new RegExp(`^${NSID}$`).test(collection)) {
    throw new TypeError(`Invalid Space record collection: ${collection}`);
  }
  if (!new RegExp(`^${RKEY}$`).test(rkey)) {
    throw new TypeError(`Invalid Space record key: ${rkey}`);
  }
  return { ...space, uri: value, spaceUri, writerDid, collection, rkey };
}

export function formatSpaceRecordUri(input: {
  spaceUri: string;
  writerDid: string;
  collection: string;
  rkey: string;
}): string {
  parseSpaceUri(input.spaceUri);
  const value = `${input.spaceUri}/${input.writerDid}/${input.collection}/${input.rkey}`;
  parseSpaceRecordUri(value);
  return value;
}

/** Opaque key consumed by Contrail's protocol-neutral isolated projector. */
export function spaceProjectionKey(spaceUri: string, generation: number): string {
  parseSpaceUri(spaceUri);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("Space generation must be a non-negative integer");
  }
  return `${spaceUri}\u0000${generation}`;
}
