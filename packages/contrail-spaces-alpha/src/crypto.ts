export interface EncryptedValue {
  version: 1;
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function cryptoApi(): Crypto {
  const api = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto;
  if (!api?.subtle) throw new Error("WebCrypto is required");
  return api;
}

export async function generateCredentialEncryptionKey(): Promise<string> {
  return base64(cryptoApi().getRandomValues(new Uint8Array(32)));
}

async function importKey(value: string): Promise<CryptoKey> {
  const bytes = fromBase64(value);
  if (bytes.byteLength !== 32) {
    throw new TypeError(
      "credential encryption key must contain exactly 32 bytes",
    );
  }
  return cryptoApi().subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(
  value: unknown,
  keyValue: string,
  context: string,
): Promise<EncryptedValue> {
  const key = await importKey(keyValue);
  const iv = cryptoApi().getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const additionalData = new TextEncoder().encode(context);
  const encrypted = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  return {
    version: 1,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  };
}

export async function decryptJson<T>(
  value: EncryptedValue,
  keyValue: string,
  context: string,
): Promise<T> {
  if (value.version !== 1)
    throw new Error("Unsupported encrypted value version");
  const key = await importKey(keyValue);
  const plaintext = await cryptoApi().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(value.iv),
      additionalData: new TextEncoder().encode(context),
    },
    key,
    fromBase64(value.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

/** Decode untrusted claims for consistency/expiry checks. Signature validation
 * remains the responsibility of the protocol endpoint that consumes the JWT. */
export function decodeJwtClaims(token: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TypeError("Expected a compact JWT");
  try {
    const decoded = new TextDecoder().decode(fromBase64(parts[1]));
    const claims = JSON.parse(decoded);
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      throw new Error("claims are not an object");
    }
    return claims as JwtClaims;
  } catch (error) {
    throw new TypeError(`Invalid JWT claims: ${(error as Error).message}`);
  }
}

export type DelegationFailure =
  "DelegationIssuerMismatch" | "DelegationSpaceMismatch" | "DelegationExpired";

/** Check an unverified delegation token's claims against the user and Space
 * it is presented for. The authority verifies the signature on exchange. */
export function delegationFailure(
  token: string,
  expected: { userDid: string; spaceUri: string; now?: number },
): DelegationFailure | null {
  const claims = decodeJwtClaims(token);
  const subject =
    typeof claims.iss === "string"
      ? claims.iss
      : typeof claims.sub === "string"
        ? claims.sub
        : null;
  if (subject?.split("#", 1)[0] !== expected.userDid)
    return "DelegationIssuerMismatch";
  if (typeof claims.sub === "string" && claims.sub !== expected.spaceUri)
    return "DelegationSpaceMismatch";
  if (
    typeof claims.exp === "number" &&
    claims.exp * 1000 <= (expected.now ?? Date.now())
  )
    return "DelegationExpired";
  return null;
}

export function jwtExpiresAt(token: string): number | null {
  const exp = decodeJwtClaims(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}
