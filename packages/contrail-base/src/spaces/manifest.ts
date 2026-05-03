/** Membership manifest: a short-lived signed list of spaces a caller is a
 *  member of, issued by an authority. Lets appviews filter unioned queries
 *  without syncing the full member list — each user carries their own
 *  bounded slice as they hit the appview.
 *
 *  Same signing infrastructure as space credentials (ES256 JWT), different
 *  payload + endpoint. */

import {
  signCredential,
  verifyCredential,
  decodeUnverifiedClaims,
  type CredentialKeyMaterial,
} from "./credentials";

const ALG = "ES256";
const TYP = "JWT";
const DEFAULT_KEY_ID = "atproto_space_authority";

/** Default manifest TTL — same 2h as credentials. */
export const DEFAULT_MANIFEST_TTL_MS = 2 * 60 * 60 * 1000;

export interface MembershipManifestClaims {
  /** Authority DID that issued (and signed) the manifest. */
  iss: string;
  /** User DID this manifest is for. */
  sub: string;
  /** Space URIs the user is a member of (according to this authority). */
  spaces: string[];
  /** Seconds since epoch. */
  iat: number;
  exp: number;
}

/** Sign a manifest using the authority's signing key. */
export async function signMembershipManifest(
  payload: MembershipManifestClaims,
  key: CredentialKeyMaterial
): Promise<string> {
  // signCredential internally builds the JWT given a CredentialClaims-like
  // shape. The manifest payload has different fields (`spaces` instead of
  // `space`/`scope`) so we hand-roll the JWT here using the same utilities.
  const enc = new TextEncoder();
  const kid = `${payload.iss}#${key.keyId ?? DEFAULT_KEY_ID}`;
  const header = { alg: ALG, typ: TYP, kid };
  const head = base64urlEncode(enc.encode(JSON.stringify(header)));
  const body = base64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${head}.${body}`;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    key.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    enc.encode(signingInput)
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
}

/** Issue a manifest with current iat/exp. */
export async function issueMembershipManifest(
  args: Omit<MembershipManifestClaims, "iat" | "exp"> & { ttlMs: number },
  key: CredentialKeyMaterial
): Promise<{ manifest: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expSec = now + Math.floor(args.ttlMs / 1000);
  const payload: MembershipManifestClaims = {
    iss: args.iss,
    sub: args.sub,
    spaces: args.spaces,
    iat: now,
    exp: expSec,
  };
  const manifest = await signMembershipManifest(payload, key);
  return { manifest, expiresAt: expSec * 1000 };
}

export type ManifestVerifyOk = { ok: true; claims: MembershipManifestClaims };
export type ManifestVerifyErr = {
  ok: false;
  reason: "malformed" | "bad-alg" | "bad-signature" | "expired" | "not-yet-valid" | "unknown-issuer";
};

export interface VerifyManifestOptions {
  /** Resolve the issuer's verification key. */
  resolveKey: (iss: string, kid: string | undefined) => Promise<JsonWebKey | null>;
  /** Time provider for tests. */
  now?: () => number;
}

export async function verifyMembershipManifest(
  jwt: string,
  opts: VerifyManifestOptions
): Promise<ManifestVerifyOk | ManifestVerifyErr> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headSeg, bodySeg, sigSeg] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: MembershipManifestClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headSeg)));
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(bodySeg)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== ALG) return { ok: false, reason: "bad-alg" };
  if (!Array.isArray(claims.spaces)) return { ok: false, reason: "malformed" };

  const nowMs = (opts.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (claims.iat > nowSec + 60) return { ok: false, reason: "not-yet-valid" };

  const jwk = await opts.resolveKey(claims.iss, header.kid);
  if (!jwk) return { ok: false, reason: "unknown-issuer" };

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const sigBytes = base64urlDecode(sigSeg);
  const enc = new TextEncoder();
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sigBytes as BufferSource,
    enc.encode(`${headSeg}.${bodySeg}`)
  );
  if (!valid) return { ok: false, reason: "bad-signature" };
  return { ok: true, claims };
}

/** Stateful manifest verifier with a TTL'd in-memory cache keyed by JWT.
 *  Returns the same shape as {@link verifyMembershipManifest}; cache hits skip
 *  the crypto round-trip but still respect `exp`. Reuse one verifier per
 *  process — never construct per-request. */
export interface ManifestVerifier {
  verify(jwt: string): Promise<ManifestVerifyOk | ManifestVerifyErr>;
}

/** Build a manifest verifier with caching. The cache is unbounded for now —
 *  manifests are short-lived (default 2h) and clients typically refresh them,
 *  so cardinality is bounded by active-user count. */
export function createManifestVerifier(opts: VerifyManifestOptions): ManifestVerifier {
  const cache = new Map<string, ManifestVerifyOk | ManifestVerifyErr>();
  const now = opts.now ?? Date.now;
  return {
    async verify(jwt) {
      const cached = cache.get(jwt);
      if (cached) {
        if (cached.ok) {
          if (cached.claims.exp * 1000 > now()) return cached;
          cache.delete(jwt);
        } else {
          // Negative cache only for permanent failures (signature, alg);
          // expired / not-yet-valid will roll over with the clock.
          if (cached.reason === "bad-signature" || cached.reason === "bad-alg" || cached.reason === "malformed") {
            return cached;
          }
          cache.delete(jwt);
        }
      }
      const result = await verifyMembershipManifest(jwt, opts);
      cache.set(jwt, result);
      return result;
    },
  };
}

/** Peek at claims without verifying — useful for routing decisions. */
export function decodeUnverifiedManifest(jwt: string): MembershipManifestClaims | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]!))) as MembershipManifestClaims;
  } catch {
    return null;
  }
}

// Local base64url helpers — mirror the credentials module so we don't expose
// these as public utilities.
function base64urlEncode(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
