const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToB64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += B64U_ALPHABET[b0 >> 2];
    out += B64U_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64U_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64U_ALPHABET[b2 & 63];
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** Generate a fresh invite token (cryptographically random, 32 bytes base64url-encoded). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64Url(bytes);
}

/** SHA-256 hash of a token, hex-encoded. Used as the PK in storage so raw tokens are never persisted. */
export async function hashInviteToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(digest));
}

/** Convenience: generate a token and return both the raw form (returned to
 *  the creator once) and its hash (persisted as the stable ID). */
export async function mintInviteToken(): Promise<{ token: string; tokenHash: string }> {
  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  return { token, tokenHash };
}
