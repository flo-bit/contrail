/** Space-credential primitives: ES256 (P-256) JWTs minted by the authority,
 *  verified by the record host (or any third party that can resolve the
 *  authority's DID document).
 *
 *  Format is a compact JWS:
 *    header  = { alg: "ES256", typ: "JWT", kid: "<authorityDid>#<keyId>" }
 *    payload = { iss, sub, space, scope, iat, exp }
 *
 *  - `iss` is the authority DID (the signer; for phase 3 this is the local
 *    authority's serviceDid; phase 4 adds a binding-resolution layer that
 *    lets the issuer be a *different* DID from the space owner).
 *  - `sub` is the caller DID — the credential bearer.
 *  - `space` is the full `ats://<owner>/<type>/<key>` URI.
 *  - `scope` is "rw" or "read".
 *
 *  We don't use a JWT library — Web Crypto's subtle covers everything (P-256
 *  generate, sign, verify, JWK import/export) and saves a runtime dep. */

const ALG = "ES256";
const TYP = "JWT";
const DEFAULT_KEY_ID = "atproto_space_authority";

export type CredentialScope = "rw" | "read";

export interface CredentialClaims {
  iss: string;
  sub: string;
  space: string;
  scope: CredentialScope;
  iat: number; // seconds since epoch
  exp: number; // seconds since epoch
}

export interface CredentialKeyMaterial {
  /** Private key in JWK form. P-256 / ES256. */
  privateKey: JsonWebKey;
  /** Public key in JWK form. Must match privateKey. */
  publicKey: JsonWebKey;
  /** DID-doc verification method id. The full JWT `kid` becomes
   *  `<authorityDid>#<keyId>`. Defaults to "atproto_space_authority". */
  keyId?: string;
}

/** Generate a fresh P-256 keypair as JWKs. Useful for local dev / tests; in
 *  production the operator generates once and stores out-of-band. */
export async function generateAuthoritySigningKey(): Promise<CredentialKeyMaterial> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicKey = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateKey, publicKey };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64urlEncode(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonEncode(value: unknown): string {
  return base64urlEncode(enc.encode(JSON.stringify(value)));
}

function jsonDecode<T>(seg: string): T {
  return JSON.parse(dec.decode(base64urlDecode(seg))) as T;
}

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

/** Sign a credential payload with the authority's private key.
 *  `iat` and `exp` are filled in by the caller (so tests can mint expired
 *  tokens deterministically). */
export async function signCredential(
  payload: CredentialClaims,
  key: CredentialKeyMaterial
): Promise<string> {
  const kid = `${payload.iss}#${key.keyId ?? DEFAULT_KEY_ID}`;
  const header = { alg: ALG, typ: TYP, kid };
  const head = jsonEncode(header);
  const body = jsonEncode(payload);
  const signingInput = `${head}.${body}`;
  const privateKey = await importPrivate(key.privateKey);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    enc.encode(signingInput)
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
}

/** Issue a credential using the current wall-clock for iat/exp. */
export async function issueCredential(
  args: Omit<CredentialClaims, "iat" | "exp"> & { ttlMs: number },
  key: CredentialKeyMaterial
): Promise<{ credential: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expSec = now + Math.floor(args.ttlMs / 1000);
  const claims: CredentialClaims = {
    iss: args.iss,
    sub: args.sub,
    space: args.space,
    scope: args.scope,
    iat: now,
    exp: expSec,
  };
  const credential = await signCredential(claims, key);
  return { credential, expiresAt: expSec * 1000 };
}

export type VerifyOk = { ok: true; claims: CredentialClaims };
export type VerifyErr = {
  ok: false;
  reason:
    | "malformed"
    | "bad-alg"
    | "bad-signature"
    | "expired"
    | "not-yet-valid"
    | "wrong-space"
    | "wrong-scope"
    | "unknown-issuer";
};

export interface VerifyOptions {
  /** Optional: when set, rejects credentials whose `space` claim differs.
   *  Omit when verifying in middleware where the target space isn't known
   *  yet — handlers can do the match themselves against the verified
   *  claims. */
  expectedSpace?: string;
  /** Optional: required scope (e.g. "rw" rejects read-only credentials on writes). */
  requiredScope?: CredentialScope;
  /** Resolve a verification key for `iss`. If null, verification fails with
   *  unknown-issuer. */
  resolveKey: (iss: string, kid: string | undefined) => Promise<JsonWebKey | null>;
  /** Time provider for tests. Returns ms since epoch. */
  now?: () => number;
}

export async function verifyCredential(
  jwt: string,
  opts: VerifyOptions
): Promise<VerifyOk | VerifyErr> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headSeg, bodySeg, sigSeg] = parts as [string, string, string];

  let header: { alg?: string; typ?: string; kid?: string };
  let claims: CredentialClaims;
  try {
    header = jsonDecode(headSeg);
    claims = jsonDecode(bodySeg);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== ALG) return { ok: false, reason: "bad-alg" };
  if (opts.expectedSpace !== undefined && claims.space !== opts.expectedSpace) {
    return { ok: false, reason: "wrong-space" };
  }
  if (opts.requiredScope === "rw" && claims.scope !== "rw") {
    return { ok: false, reason: "wrong-scope" };
  }

  const nowMs = (opts.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (claims.iat > nowSec + 60) return { ok: false, reason: "not-yet-valid" };

  const jwk = await opts.resolveKey(claims.iss, header.kid);
  if (!jwk) return { ok: false, reason: "unknown-issuer" };

  const publicKey = await importPublic(jwk);
  const sigBytes = base64urlDecode(sigSeg);
  const signingInput = `${headSeg}.${bodySeg}`;
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sigBytes as BufferSource,
    enc.encode(signingInput)
  );
  if (!valid) return { ok: false, reason: "bad-signature" };
  return { ok: true, claims };
}

/** Header reader for handlers that want to peek at `iss` before resolving the
 *  key (e.g. to short-circuit DID-doc fetches for the local authority). */
export function decodeUnverifiedClaims(jwt: string): CredentialClaims | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return jsonDecode<CredentialClaims>(parts[1]!);
  } catch {
    return null;
  }
}

/** Verifier interface consumed by the record host. The record host doesn't
 *  care HOW credentials get verified — it only cares whether a given JWT is
 *  valid. Phase 3 ships an in-process verifier that knows the local
 *  authority's public key; phase 4 adds a binding-resolving verifier that
 *  consults PDS records / DID docs. */
export interface CredentialVerifier {
  /** Verify a credential's signature, expiry, and `not-before` window. Does
   *  NOT enforce a space match — handlers do that against the request URI. */
  verify(jwt: string): Promise<VerifyOk | VerifyErr>;
}

/** In-process verifier for the simple deployment: the authority and record
 *  host run in one process and the record host has direct access to the
 *  authority's public key. Rejects any credential whose `iss` isn't the
 *  configured authority. Phase 4 has a more general
 *  {@link createBindingCredentialVerifier} that does proper binding lookup. */
export function createInProcessVerifier(args: {
  authorityDid: string;
  publicKey: JsonWebKey;
}): CredentialVerifier {
  return {
    verify(jwt) {
      return verifyCredential(jwt, {
        resolveKey: async (iss) => (iss === args.authorityDid ? args.publicKey : null),
      });
    },
  };
}

/** Verifier composed of a {@link BindingResolver} (which DID is authorized
 *  to issue for this space?) and a {@link KeyResolver} (what's that DID's
 *  public key?). This is the production-shape verifier — phase 4's main
 *  contribution.
 *
 *  Verification flow:
 *    1. Decode the JWT's claims (no signature check yet).
 *    2. Ask the binding resolver: who's authorized for `claims.space`?
 *    3. Confirm `claims.iss === authorizedDid`.
 *    4. Ask the key resolver for that DID's verification key.
 *    5. Verify signature + expiry + scope match.
 */
export function createBindingCredentialVerifier(args: {
  bindings: import("./binding").BindingResolver;
  keys: import("./binding").KeyResolver;
}): CredentialVerifier {
  return {
    async verify(jwt) {
      const peek = decodeUnverifiedClaims(jwt);
      if (!peek) return { ok: false, reason: "malformed" };
      const authorizedDid = await args.bindings.resolveAuthority(peek.space);
      if (!authorizedDid) return { ok: false, reason: "unknown-issuer" };
      if (peek.iss !== authorizedDid) return { ok: false, reason: "unknown-issuer" };
      return verifyCredential(jwt, {
        resolveKey: (iss, kid) => args.keys.resolveKey(iss, kid),
      });
    },
  };
}
