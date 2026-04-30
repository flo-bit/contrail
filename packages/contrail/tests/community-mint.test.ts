import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import {
  buildGenesisOp,
  computeDidPlc,
  encodeDagCbor,
  generateKeyPair,
  jwkToDidKey,
  signGenesisOp,
} from "../src/core/community/plc";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

const MASTER_KEY = new Uint8Array(32).fill(99);

/** Captures requests that would have gone to plc.directory. */
const plcCalls: Array<{ url: string; method: string; body: any }> = [];

const CONFIG: ContrailConfig = {
  namespace: "test.comm",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    authority: {
      type: "tools.atmo.event.space",
      serviceDid: "did:web:test.example#svc",
    },
    recordHost: {},
  },
  community: {
    masterKey: MASTER_KEY,
    plcDirectory: "https://plc.test",
    fetch: mockFetch,
  },
};

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body as string) : {};
  if (url.startsWith("https://plc.test/")) {
    plcCalls.push({ url, method, body });
    return new Response("{}", { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

function fakeAuth(): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", { issuer: did, audience: CONFIG.spaces!.authority!.serviceDid, lxm: undefined });
    await next();
  };
}

async function makeApp(): Promise<Hono> {
  const db = createSqliteDatabase(":memory:");
  const resolved = resolveConfig(CONFIG);
  await initSchema(db, resolved);
  return createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
}

function call(
  app: Hono,
  method: string,
  path: string,
  did: string,
  body?: any
): Promise<Response> {
  const headers: Record<string, string> = { "X-Test-Did": did };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

describe("plc op encoding (unit)", () => {
  it("encodes canonical CBOR with sorted map keys", () => {
    // Maps must be sorted by key length first, then lexicographically.
    const out = encodeDagCbor({ b: 1, a: 2, ab: 3 });
    // Expected order: a, b, ab (short keys first).
    // Header byte: major 5 (map), count 3 → 0xa3.
    expect(out[0]).toBe(0xa3);
    // First key should be "a" (0x61 text-string head len 1, then 0x61).
    expect(out[1]).toBe(0x61);
    expect(out[2]).toBe(0x61);
  });

  it("generates a P-256 keypair and a did:key", async () => {
    const pair = await generateKeyPair();
    expect(pair.publicDidKey).toMatch(/^did:key:z/);
    expect(pair.privateJwk.kty).toBe("EC");
    expect(pair.privateJwk.crv).toBe("P-256");
  });

  it("computeDidPlc returns a stable did:plc", async () => {
    const signing = await generateKeyPair();
    const rotation = await generateKeyPair();
    const unsigned = buildGenesisOp({
      rotationKeys: [rotation.publicDidKey],
      verificationMethodAtproto: signing.publicDidKey,
    });
    const signed = await signGenesisOp(unsigned, rotation.privateJwk);
    const did = await computeDidPlc(signed);
    expect(did).toMatch(/^did:plc:[a-z2-7]{24}$/);
  });

  it("jwkToDidKey: public key roundtrip shape", async () => {
    const pair = await generateKeyPair();
    const k = jwkToDidKey(pair.privateJwk); // private JWK carries the pub coords
    expect(k).toBe(pair.publicDidKey);
  });
});

describe("community.mint — stage 4", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await makeApp();
  });

  it("mints a community, returns recovery key, submits to PLC, bootstraps reserved spaces", async () => {
    const before = plcCalls.length;
    const res = await call(app, "POST", "/xrpc/test.comm.community.mint", ALICE, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.communityDid).toMatch(/^did:plc:[a-z2-7]{24}$/);
    // Recovery key is a private JWK returned once.
    expect(body.recoveryKey.kty).toBe("EC");
    expect(body.recoveryKey.crv).toBe("P-256");
    expect(body.recoveryKey.d).toBeTruthy(); // private scalar

    // PLC submission happened.
    const ourCalls = plcCalls.slice(before);
    expect(ourCalls).toHaveLength(1);
    expect(ourCalls[0]!.method).toBe("POST");
    expect(ourCalls[0]!.url).toBe(`https://plc.test/${body.communityDid}`);
    expect(ourCalls[0]!.body.type).toBe("plc_operation");
    expect(ourCalls[0]!.body.sig).toBeTruthy();
    expect(ourCalls[0]!.body.rotationKeys).toHaveLength(2);

    // Reserved spaces exist with the caller as owner.
    const adminUri = `ats://${body.communityDid}/tools.atmo.event.space/$admin`;
    const whoami = await call(app, "GET", `/xrpc/test.comm.spaceExt.whoami?spaceUri=${encodeURIComponent(adminUri)}`, ALICE);
    expect(((await whoami.json()) as any).accessLevel).toBe("owner");
  });

  it("minted community rejects publishing (no PDS)", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.mint", ALICE, {});
    const { communityDid } = (await res.json()) as any;

    const pub = await call(app, "POST", "/xrpc/test.comm.community.putRecord", ALICE, {
      communityDid,
      collection: "app.event.message",
      record: { text: "nope" },
    });
    expect(pub.status).toBe(400);
    expect(((await pub.json()) as any).reason).toBe("publishing-not-supported-for-minted-communities");
  });

  it("multiple mints produce distinct DIDs", async () => {
    const r1 = await call(app, "POST", "/xrpc/test.comm.community.mint", BOB, {});
    const r2 = await call(app, "POST", "/xrpc/test.comm.community.mint", BOB, {});
    const d1 = ((await r1.json()) as any).communityDid;
    const d2 = ((await r2.json()) as any).communityDid;
    expect(d1).not.toBe(d2);
  });
});
