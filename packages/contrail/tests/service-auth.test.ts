import { describe, it, expect } from "vitest";
import { mintServiceAuthJwt } from "../src/core/community/service-auth";
import { generateKeyPair } from "../src/core/community/plc";

function b64urlDecode(s: string): Uint8Array {
  const normal = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwtJson(seg: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(seg)));
}

/** P-256 curve order; used for low-S threshold. */
const P256_N = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const P256_N_HALF = P256_N >> 1n;

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

describe("mintServiceAuthJwt", () => {
  it("round-trips: signature verifies against the keypair's public key (P1363, not DER)", async () => {
    // This is the canary: if the signer accidentally returns DER instead of raw r||s,
    // Web Crypto's verify with raw form will reject it — and so will atproto PDSes.
    const kp = await generateKeyPair();
    const jwt = await mintServiceAuthJwt({
      privateJwk: kp.privateJwk,
      iss: "did:plc:abc",
      aud: "did:web:pds.test",
      lxm: "com.atproto.server.createAccount",
    });

    // Reconstruct the public JWK from the private JWK (drop d, key_ops, ext).
    const priv = kp.privateJwk as Record<string, unknown>;
    const publicJwk: JsonWebKey = {
      kty: priv.kty as string,
      crv: priv.crv as string,
      x: priv.x as string,
      y: priv.y as string,
    };
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    const [h, p, s] = jwt.split(".");
    const signedBytes = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64urlDecode(s!);

    // P1363 form is exactly 64 bytes for P-256. DER would be ~70-72 and start with 0x30.
    expect(sig.length).toBe(64);

    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig as BufferSource,
      signedBytes as BufferSource
    );
    expect(ok).toBe(true);
  });

  it("emits low-S signatures across many independent signings", async () => {
    // Without normalization, ~50% of ECDSA signatures have s > n/2.
    // Across 12 fresh keypairs, the probability of *all* being naturally low-S is
    // ~1/4096. If the test ever sees a high-S signature, normalization is broken.
    const kp = await generateKeyPair();
    for (let i = 0; i < 12; i++) {
      const jwt = await mintServiceAuthJwt({
        privateJwk: kp.privateJwk,
        iss: "did:plc:abc",
        aud: "did:web:pds.test",
        lxm: "com.atproto.server.createAccount",
        // Force a fresh signature each iteration; ECDSA k is randomized per sign.
      });
      const sig = b64urlDecode(jwt.split(".")[2]!);
      const s = bytesToBigInt(sig.slice(32));
      expect(s).toBeLessThanOrEqual(P256_N_HALF);
    }
  });

  it("encodes header and claims as base64url JSON with the expected shape", async () => {
    const kp = await generateKeyPair();
    const fixedNow = 1_700_000_000_000;
    const jwt = await mintServiceAuthJwt({
      privateJwk: kp.privateJwk,
      iss: "did:plc:abc",
      aud: "did:web:pds.test",
      lxm: "com.atproto.server.createAccount",
      ttlSec: 60,
      now: fixedNow,
    });

    const [h, p] = jwt.split(".");
    const header = decodeJwtJson(h!);
    const payload = decodeJwtJson(p!);

    // Header MUST be exactly {alg,typ}; presence of kid would change the
    // signed bytes and break PDS verification (which doesn't use kid).
    expect(header).toEqual({ alg: "ES256", typ: "JWT" });

    expect(payload.iss).toBe("did:plc:abc");
    expect(payload.aud).toBe("did:web:pds.test");
    expect(payload.lxm).toBe("com.atproto.server.createAccount");
    expect(payload.iat).toBe(Math.floor(fixedNow / 1000));
    expect(payload.exp).toBe(Math.floor(fixedNow / 1000) + 60);
    expect(typeof payload.jti).toBe("string");
    expect((payload.jti as string).length).toBeGreaterThan(0);
  });

  it("uses unique jti per call (replay-protection sanity)", async () => {
    const kp = await generateKeyPair();
    const mk = () =>
      mintServiceAuthJwt({
        privateJwk: kp.privateJwk,
        iss: "did:plc:abc",
        aud: "did:web:pds.test",
        lxm: "com.atproto.server.createAccount",
      });
    const a = decodeJwtJson((await mk()).split(".")[1]!);
    const b = decodeJwtJson((await mk()).split(".")[1]!);
    expect(a.jti).not.toBe(b.jti);
  });
});
