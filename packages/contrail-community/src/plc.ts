/** did:plc minting: key generation, genesis op construction, signing,
 *  submission. Zero external deps — uses Web Crypto for P-256 and a
 *  minimal hand-rolled DAG-CBOR encoder for the specific op shape. */

// ============================================================================
// Key handling (P-256 / ES256)
// ============================================================================

export interface KeyPair {
  /** JWK of the private key; stored encrypted. */
  privateJwk: JsonWebKey;
  /** did:key multibase encoding of the public key. */
  publicDidKey: string;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateJwk, publicDidKey: jwkToDidKey(publicJwk) };
}

/** Convert a P-256 JWK public key to did:key format.
 *  multicodec for P-256 pub: 0x1200 (varint: [0x80, 0x24]).
 *  did:key:zBase58btc(multicodec || compressed-pub-key). */
export function jwkToDidKey(jwk: JsonWebKey): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("expected EC P-256 JWK");
  }
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("malformed P-256 JWK");
  }
  // Compressed form: 0x02 if y is even, 0x03 if odd, then x.
  const prefix = (y[31]! & 1) === 0 ? 0x02 : 0x03;
  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  const multicodec = new Uint8Array([0x80, 0x24]);
  const combined = new Uint8Array(multicodec.length + compressed.length);
  combined.set(multicodec, 0);
  combined.set(compressed, multicodec.length);
  return "did:key:z" + base58btcEncode(combined);
}

/** Order of the P-256 curve (n). */
const P256_N = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const P256_N_HALF = P256_N >> 1n;

export async function signBytes(privateJwk: JsonWebKey, bytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes as BufferSource)
  );
  // Web Crypto returns IEEE P1363 form: r || s (32 bytes each for P-256).
  // atproto/PLC (and most modern ECDSA consumers) require low-S — i.e.
  // s must be in the lower half of the curve order. Flip high-S signatures
  // by replacing s with n - s. This yields an equivalent valid signature.
  return normalizeLowS(sig);
}

function normalizeLowS(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) return sig; // not a P-256 P1363 sig — don't touch
  const r = sig.slice(0, 32);
  const sBytes = sig.slice(32);
  const s = bytesToBigInt(sBytes);
  if (s <= P256_N_HALF) return sig;
  const sLow = P256_N - s;
  const sLowBytes = bigIntToBytes(sLow, 32);
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(sLowBytes, 32);
  return out;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = v;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// ============================================================================
// Genesis op construction
// ============================================================================

export interface GenesisOpInput {
  rotationKeys: string[]; // did:key strings
  verificationMethodAtproto: string; // did:key
  services?: Record<string, { type: string; endpoint: string }>;
  alsoKnownAs?: string[];
}

export interface UnsignedGenesisOp {
  type: "plc_operation";
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
  prev: null;
}

export interface SignedGenesisOp extends UnsignedGenesisOp {
  sig: string; // base64url, unpadded
}

export function buildGenesisOp(input: GenesisOpInput): UnsignedGenesisOp {
  return {
    type: "plc_operation",
    rotationKeys: input.rotationKeys,
    verificationMethods: { atproto: input.verificationMethodAtproto },
    alsoKnownAs: input.alsoKnownAs ?? [],
    services: input.services ?? {},
    prev: null,
  };
}

/** Sign a genesis op with a rotation key's private JWK. */
export async function signGenesisOp(
  op: UnsignedGenesisOp,
  signerPrivateJwk: JsonWebKey
): Promise<SignedGenesisOp> {
  const encoded = encodeDagCbor(op);
  const sigBytes = await signBytes(signerPrivateJwk, encoded);
  return { ...op, sig: bytesToB64url(sigBytes) };
}

/** Compute the did:plc from a signed genesis op.
 *  The DID is `did:plc:` + base32-lower-unpadded(sha256(cbor(signedOp)))[:24]. */
export async function computeDidPlc(signedOp: SignedGenesisOp): Promise<string> {
  const encoded = encodeDagCbor(signedOp);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded as BufferSource));
  return "did:plc:" + base32Lower(hash).slice(0, 24);
}

// ============================================================================
// Update op construction (subsequent ops chain via `prev`)
// ============================================================================

export interface UpdateOpInput {
  prev: string; // CID string of the previous op in the chain
  rotationKeys: string[];
  verificationMethodAtproto: string;
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
}

export interface UnsignedUpdateOp {
  type: "plc_operation";
  prev: string;
  rotationKeys: string[];
  verificationMethods: { atproto: string };
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
}

export interface SignedUpdateOp extends UnsignedUpdateOp {
  sig: string; // base64url, unpadded
}

export function buildUpdateOp(input: UpdateOpInput): UnsignedUpdateOp {
  return {
    type: "plc_operation",
    prev: input.prev,
    rotationKeys: input.rotationKeys,
    verificationMethods: { atproto: input.verificationMethodAtproto },
    alsoKnownAs: input.alsoKnownAs,
    services: input.services,
  };
}

/** Sign an update op with a rotation key's private JWK. */
export async function signUpdateOp(
  unsigned: UnsignedUpdateOp,
  signerPrivateJwk: JsonWebKey
): Promise<SignedUpdateOp> {
  const encoded = encodeDagCbor(unsigned);
  const sigBytes = await signBytes(signerPrivateJwk, encoded);
  return { ...unsigned, sig: bytesToB64url(sigBytes) };
}

/** Compute the CIDv1 for a signed op (genesis, update, or tombstone).
 *  CIDv1 (0x01) + dag-cbor codec (0x71) + sha2-256 (0x12 0x20) + hash,
 *  base32-lower with multibase "b" prefix.
 *
 *  The tombstone shape ({type, prev, sig}) is a strict subset of update —
 *  the DAG-CBOR encoder accepts all three uniformly, and PLC computes its
 *  stored CID from the same canonical encoding. */
export async function cidForOp(
  signedOp: SignedGenesisOp | SignedUpdateOp | SignedTombstoneOp
): Promise<string> {
  const encoded = encodeDagCbor(signedOp);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoded as BufferSource)
  );
  const cidBytes = new Uint8Array(4 + hash.length);
  cidBytes[0] = 0x01;
  cidBytes[1] = 0x71;
  cidBytes[2] = 0x12;
  cidBytes[3] = 0x20;
  cidBytes.set(hash, 4);
  return "b" + base32Lower(cidBytes);
}

/** Fetch the CID of the most recent op in a DID's PLC log. Used during
 *  provision recovery to obtain the genesis op's CID at resume time (we can't
 *  recompute it locally because ECDSA signatures are randomized) and by the
 *  reap CLI to chain a tombstone onto the latest op.
 *
 *  PLC's `/log/last` endpoint returns the bare signed op object — no envelope,
 *  no `cid` field. We compute the CID locally with the same DAG-CBOR encoder
 *  cidForOp uses; PLC computes its stored CID identically, so the result
 *  matches the entry's CID in `/log/audit`. */
export async function getLastOpCid(
  plcDirectory: string,
  did: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<string> {
  const f = opts.fetch ?? fetch;
  const url = `${plcDirectory.replace(/\/$/, "")}/${did}/log/last`;
  const res = await f(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PLC log/last failed (${res.status}): ${text}`);
  }
  const op = (await res.json()) as
    | SignedGenesisOp
    | SignedUpdateOp
    | SignedTombstoneOp;
  return cidForOp(op);
}

// ============================================================================
// Tombstone op construction
// A tombstone op marks a DID's PLC log as terminated — no further ops will be
// accepted. Used by `contrail reap` to clean up DIDs whose PDS account is
// permanently unrecoverable.
// ============================================================================

export interface UnsignedTombstoneOp {
  type: "plc_tombstone";
  prev: string;
}

export interface SignedTombstoneOp extends UnsignedTombstoneOp {
  sig: string; // base64url, unpadded
}

export function buildTombstoneOp(prev: string): UnsignedTombstoneOp {
  return { type: "plc_tombstone", prev };
}

/** Sign a tombstone op with a rotation key's private JWK. */
export async function signTombstoneOp(
  op: UnsignedTombstoneOp,
  signerPrivateJwk: JsonWebKey
): Promise<SignedTombstoneOp> {
  const encoded = encodeDagCbor(op);
  const sigBytes = await signBytes(signerPrivateJwk, encoded);
  return { ...op, sig: bytesToB64url(sigBytes) };
}

/** Submit a signed tombstone op to the PLC directory. PLC accepts genesis,
 *  update, and tombstone ops at the same `${plcDirectory}/${did}` endpoint. */
export async function submitTombstoneOp(
  plcDirectory: string,
  did: string,
  signedOp: SignedTombstoneOp,
  opts: { fetch?: typeof fetch } = {}
): Promise<void> {
  const f = opts.fetch ?? fetch;
  const url = `${plcDirectory.replace(/\/$/, "")}/${did}`;
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signedOp),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PLC tombstone submit failed (${res.status}): ${text}`);
  }
}

/** Submit a signed genesis op to the PLC directory. */
export async function submitGenesisOp(
  plcDirectory: string,
  did: string,
  signedOp: SignedGenesisOp,
  opts: { fetch?: typeof fetch } = {}
): Promise<void> {
  const f = opts.fetch ?? fetch;
  const url = `${plcDirectory.replace(/\/$/, "")}/${did}`;
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signedOp),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PLC submit failed (${res.status}): ${text}`);
  }
}

// ============================================================================
// Minimal DAG-CBOR encoder
// Only supports the types needed for PLC genesis ops:
// null, text strings, arrays, maps with string keys.
// Maps are canonicalized: keys sorted by their CBOR byte encoding,
// ascending lexicographically. Integers use the smallest encoding.
// See RFC 8949 + https://ipld.io/specs/codecs/dag-cbor/spec/
// ============================================================================

export function encodeDagCbor(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];
  encode(value, chunks);
  return concat(chunks);
}

function encode(value: unknown, out: Uint8Array[]): void {
  if (value === null) {
    out.push(new Uint8Array([0xf6]));
    return;
  }
  if (value === false) {
    out.push(new Uint8Array([0xf4]));
    return;
  }
  if (value === true) {
    out.push(new Uint8Array([0xf5]));
    return;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    encodeHead(3, bytes.length, out);
    out.push(bytes);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("DAG-CBOR: floats not supported in PLC op encoder");
    }
    if (value >= 0) {
      encodeHead(0, value, out);
    } else {
      encodeHead(1, -value - 1, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    encodeHead(4, value.length, out);
    for (const v of value) encode(v, out);
    return;
  }
  if (typeof value === "object") {
    // Map with string keys, canonicalized.
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    // Sort keys by their CBOR-encoded byte form.
    // For DAG-CBOR with text-string keys, this equals:
    // (a) shorter UTF-8 byte length first, (b) lexicographic byte order within same length.
    entries.sort(([a], [b]) => {
      const ab = new TextEncoder().encode(a);
      const bb = new TextEncoder().encode(b);
      if (ab.length !== bb.length) return ab.length - bb.length;
      for (let i = 0; i < ab.length; i++) {
        if (ab[i] !== bb[i]) return ab[i]! - bb[i]!;
      }
      return 0;
    });
    encodeHead(5, entries.length, out);
    for (const [k, v] of entries) {
      encode(k, out);
      encode(v, out);
    }
    return;
  }
  throw new Error(`DAG-CBOR: unsupported value type ${typeof value}`);
}

function encodeHead(majorType: number, n: number, out: Uint8Array[]): void {
  const mt = majorType << 5;
  if (n < 24) {
    out.push(new Uint8Array([mt | n]));
  } else if (n < 0x100) {
    out.push(new Uint8Array([mt | 24, n]));
  } else if (n < 0x10000) {
    out.push(new Uint8Array([mt | 25, (n >> 8) & 0xff, n & 0xff]));
  } else if (n < 0x100000000) {
    const b = new Uint8Array(5);
    b[0] = mt | 26;
    b[1] = (n >>> 24) & 0xff;
    b[2] = (n >>> 16) & 0xff;
    b[3] = (n >>> 8) & 0xff;
    b[4] = n & 0xff;
    out.push(b);
  } else {
    throw new Error("DAG-CBOR: integer too large");
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ============================================================================
// Base encoding helpers (base58btc, base32-lower-unpadded, base64url)
// ============================================================================

const B58_ALPHA =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  // Count leading zeros.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Repeated divmod by 58 using big-endian byte buffer.
  const input = Array.from(bytes);
  let encoded = "";
  let start = zeros;
  while (start < input.length) {
    let carry = 0;
    for (let i = start; i < input.length; i++) {
      const v = (carry << 8) + input[i]!;
      input[i] = Math.floor(v / 58);
      carry = v % 58;
    }
    encoded = B58_ALPHA[carry]! + encoded;
    while (start < input.length && input[start] === 0) start++;
  }
  return "1".repeat(zeros) + encoded;
}

const B32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHA[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += B32_ALPHA[(value << (5 - bits)) & 31];
  }
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const normal = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
