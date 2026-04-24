/** Subscription tickets — HMAC-signed short-lived `{topics, did, exp}` blobs.
 *
 *  Wire format: `<payload>.<sig>` where
 *    payload = base64url(JSON({ topics, did, exp, iat }))
 *    sig     = base64url(HMAC-SHA256(key, payload))
 *
 *  Tickets are integrity-only (not encrypted). Browsers use them because
 *  EventSource / WebSocket can't send Authorization headers; server-side
 *  consumers skip the ticket dance and send their JWT directly. */

export interface TicketPayload {
  /** Concrete delivery topics this ticket authorizes. `community:<did>` is
   *  expanded to the caller's visible spaces before signing — a ticket never
   *  carries a community alias. */
  topics: string[];
  did: string;
  /** Unix ms. */
  exp: number;
  /** Unix ms — useful for debugging; ignored on verify. */
  iat: number;
  /** Optional: query-scoped watchRecords spec this ticket authorizes. Present
   *  when the ticket was minted from a watchRecords handshake. The server
   *  trusts the signed spec on upgrade and forwards it to the DO. */
  querySpec?: TicketQuerySpec;
}

export interface TicketQuerySpec {
  collection: string;
  /** Exactly one of `spaceUri` or `actor` is set. `spaceUri` = per-space
   *  watch; `actor` = cross-space watch for records authored by this DID
   *  (the ticket's `topics` list carries the expanded delivery topics). */
  spaceUri?: string;
  actor?: string;
  hydrate?: Record<string, { childCollection: string; matchField: string }>;
}

function normalizeSecret(secret: Uint8Array | string): Uint8Array {
  if (typeof secret !== "string") {
    if (secret.length !== 32) {
      throw new Error(`realtime ticketSecret must be 32 bytes, got ${secret.length}`);
    }
    return secret;
  }
  // 64 hex chars would also round-trip as base64 (to 48 bytes). Prefer hex
  // when the input matches the hex alphabet exactly; fall back to base64.
  const hex = tryHex(secret);
  if (hex && hex.length === 32) return hex;
  const b64 = tryBase64(secret);
  if (b64 && b64.length === 32) return b64;
  if (hex || b64) {
    const got = (hex ?? b64)!.length;
    throw new Error(`realtime ticketSecret must decode to 32 bytes, got ${got}`);
  }
  throw new Error("realtime ticketSecret must be a 32-byte Uint8Array or base64/hex string");
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

function b64urlFromBytes(bytes: Uint8Array): string {
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

function b64urlFromString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

function stringFromB64url(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export class TicketSigner {
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(secret: Uint8Array | string) {
    const raw = normalizeSecret(secret);
    this.keyPromise = crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
  }

  async sign(input: {
    topics: string[];
    did: string;
    ttlMs: number;
    querySpec?: TicketQuerySpec;
  }): Promise<string> {
    const now = Date.now();
    const payload: TicketPayload = {
      topics: input.topics,
      did: input.did,
      exp: now + input.ttlMs,
      iat: now,
      ...(input.querySpec ? { querySpec: input.querySpec } : {}),
    };
    const payloadPart = b64urlFromString(JSON.stringify(payload));
    const sig = await crypto.subtle.sign(
      "HMAC",
      await this.keyPromise,
      new TextEncoder().encode(payloadPart) as BufferSource
    );
    const sigPart = b64urlFromBytes(new Uint8Array(sig));
    return `${payloadPart}.${sigPart}`;
  }

  /** Returns the decoded payload if the ticket is valid + unexpired, else null. */
  async verify(ticket: string): Promise<TicketPayload | null> {
    const dot = ticket.indexOf(".");
    if (dot < 0) return null;
    const payloadPart = ticket.slice(0, dot);
    const sigPart = ticket.slice(dot + 1);
    let expectedSig: Uint8Array;
    try {
      expectedSig = b64urlToBytes(sigPart);
    } catch {
      return null;
    }
    const computedRaw = await crypto.subtle.sign(
      "HMAC",
      await this.keyPromise,
      new TextEncoder().encode(payloadPart) as BufferSource
    );
    const computed = new Uint8Array(computedRaw);
    if (!constantTimeEq(expectedSig, computed)) return null;
    let parsed: TicketPayload;
    try {
      parsed = JSON.parse(stringFromB64url(payloadPart));
    } catch {
      return null;
    }
    if (!parsed || !Array.isArray(parsed.topics) || typeof parsed.did !== "string") {
      return null;
    }
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
    return parsed;
  }
}
