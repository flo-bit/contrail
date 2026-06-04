/** Mint an ES256 service-auth JWT for PDS XRPC calls.
 *  See com.atproto.server.createAccount handler: PDS verifies
 *  iss === did, aud === pds-did, lxm === lexicon-method, exp not in past.
 *  Signature is verified against the iss DID's atproto verificationMethod. */

import { signBytes } from "./plc";

function b64url(bytes: Uint8Array | string): string {
  const b =
    typeof bytes === "string"
      ? new TextEncoder().encode(bytes)
      : bytes;
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

export interface MintServiceAuthInput {
  /** Private JWK for the signing key (atproto verificationMethod). */
  privateJwk: JsonWebKey;
  /** Issuer DID (the account's did:plc). */
  iss: string;
  /** Audience DID (the target PDS, e.g. did:web:pds.example). */
  aud: string;
  /** Lexicon method being authorized, e.g. com.atproto.server.createAccount. */
  lxm: string;
  /** Token TTL in seconds. Defaults to 60. */
  ttlSec?: number;
  /** Override "now" for deterministic tests; epoch milliseconds. */
  now?: number;
}

export async function mintServiceAuthJwt(input: MintServiceAuthInput): Promise<string> {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const ttl = input.ttlSec ?? 60;
  // Header: alg+typ only — atproto's service-auth verification doesn't use kid;
  // the signing key is resolved from the iss DID's verificationMethod.
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    iat,
    iss: input.iss,
    aud: input.aud,
    exp: iat + ttl,
    lxm: input.lxm,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  // signBytes returns IEEE P1363 r||s (64 bytes), low-S normalized.
  // JWT ES256 mandates raw r||s, NOT DER. atproto enforces low-S as well.
  const sig = await signBytes(input.privateJwk, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
