/** Envelope-encryption helpers for community credentials.
 *  AES-GCM with a 32-byte master key provided via config. */

const IV_LEN = 12;

function normalizeKey(key: Uint8Array | string): Uint8Array {
  if (typeof key !== "string") {
    if (key.length !== 32) {
      throw new Error(`community master key must be 32 bytes, got ${key.length}`);
    }
    return key;
  }
  // Try base64 first, fall back to hex.
  const bytes = tryBase64(key) ?? tryHex(key);
  if (!bytes) {
    throw new Error(
      "community master key must be a 32-byte Uint8Array or base64/hex string"
    );
  }
  if (bytes.length !== 32) {
    throw new Error(`community master key must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

function tryBase64(s: string): Uint8Array | null {
  try {
    const normal = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
    if (!/^[A-Za-z0-9+/]*=*$/.test(padded)) return null;
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function tryHex(s: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export class CredentialCipher {
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(masterKey: Uint8Array | string) {
    this.keyPromise = importKey(normalizeKey(masterKey));
  }

  /** Encrypts `plaintext` and returns a base64 string containing iv || ciphertext. */
  async encrypt(plaintext: string | Uint8Array): Promise<string> {
    const key = await this.keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const bytes =
      typeof plaintext === "string"
        ? new TextEncoder().encode(plaintext)
        : plaintext;
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      bytes as BufferSource
    );
    const combined = new Uint8Array(iv.length + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), iv.length);
    return bytesToBase64(combined);
  }

  async decrypt(encoded: string): Promise<Uint8Array> {
    const key = await this.keyPromise;
    const combined = base64ToBytes(encoded);
    if (combined.length <= IV_LEN) {
      throw new Error("ciphertext too short");
    }
    const iv = combined.subarray(0, IV_LEN);
    const ct = combined.subarray(IV_LEN);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ct as BufferSource
    );
    return new Uint8Array(pt);
  }

  async decryptString(encoded: string): Promise<string> {
    return new TextDecoder().decode(await this.decrypt(encoded));
  }
}
