import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import {
  generateAuthoritySigningKey,
  signMembershipManifest,
  verifyMembershipManifest,
  decodeUnverifiedManifest,
  issueMembershipManifest,
} from "@atmo-dev/contrail-base";
import type { CredentialKeyMaterial } from "@atmo-dev/contrail-base";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";

const SERVICE_DID = "did:web:test.example#svc";

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

function makeConfig(overrides?: Partial<ContrailConfig["spaces"] extends { authority?: infer A } ? A : never>): ContrailConfig {
  return {
    namespace: "test.man",
    collections: {
      message: { collection: "app.event.message" },
    },
    spaces: {
      authority: {
        type: "tools.atmo.event.space",
        serviceDid: SERVICE_DID,
        signing: SIGNING,
        manifestTtlMs: 60_000,
        ...(overrides ?? {}),
      },
      recordHost: {},
    },
  };
}

function fakeAuth(): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", {
      issuer: did,
      audience: SERVICE_DID,
      lxm: undefined,
      clientId: c.req.header("X-Test-App") ?? undefined,
    });
    await next();
  };
}

async function makeApp(cfg: ContrailConfig = makeConfig()): Promise<Hono> {
  const db = createSqliteDatabase(":memory:");
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);
  return createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
}

function call(app: Hono, method: string, path: string, did: string | null, body?: any) {
  const headers: Record<string, string> = {};
  if (did) headers["X-Test-Did"] = did;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

async function createSpace(app: Hono, owner: string): Promise<string> {
  const res = await call(app, "POST", "/xrpc/test.man.space.createSpace", owner, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as any).space.uri;
}

describe("membership manifest — sign/verify primitives", () => {
  it("round-trips via verifyMembershipManifest", async () => {
    const { manifest } = await issueMembershipManifest(
      {
        iss: SERVICE_DID,
        sub: ALICE,
        spaces: ["ats://a/x/1", "ats://a/x/2"],
        ttlMs: 60_000,
      },
      SIGNING
    );
    const result = await verifyMembershipManifest(manifest, {
      resolveKey: async (iss) => (iss === SERVICE_DID ? SIGNING.publicKey : null),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.iss).toBe(SERVICE_DID);
      expect(result.claims.sub).toBe(ALICE);
      expect(result.claims.spaces).toEqual(["ats://a/x/1", "ats://a/x/2"]);
    }
  });

  it("rejects expired manifests", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const manifest = await signMembershipManifest(
      {
        iss: SERVICE_DID,
        sub: ALICE,
        spaces: ["ats://a/x/1"],
        iat: past - 60,
        exp: past,
      },
      SIGNING
    );
    const result = await verifyMembershipManifest(manifest, {
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects bad signatures", async () => {
    const { manifest } = await issueMembershipManifest(
      { iss: SERVICE_DID, sub: ALICE, spaces: [], ttlMs: 60_000 },
      SIGNING
    );
    const otherKey = await generateAuthoritySigningKey();
    const result = await verifyMembershipManifest(manifest, {
      resolveKey: async () => otherKey.publicKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects unknown issuer", async () => {
    const { manifest } = await issueMembershipManifest(
      { iss: SERVICE_DID, sub: ALICE, spaces: [], ttlMs: 60_000 },
      SIGNING
    );
    const result = await verifyMembershipManifest(manifest, {
      resolveKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-issuer");
  });

  it("decodeUnverifiedManifest peeks without verifying", async () => {
    const { manifest } = await issueMembershipManifest(
      { iss: SERVICE_DID, sub: ALICE, spaces: ["ats://a/x/1"], ttlMs: 60_000 },
      SIGNING
    );
    const claims = decodeUnverifiedManifest(manifest);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(ALICE);
    expect(claims!.spaces).toEqual(["ats://a/x/1"]);
  });
});

describe("membership manifest — getMembershipManifest endpoint", () => {
  it("returns a manifest covering owned + joined spaces", async () => {
    const app = await makeApp();
    // Alice owns 2; Bob joins one of them.
    const uriA1 = await createSpace(app, ALICE);
    const uriA2 = await createSpace(app, ALICE);
    await call(app, "POST", "/xrpc/test.man.space.addMember", ALICE, {
      spaceUri: uriA1,
      did: BOB,
    });
    // Bob also owns one.
    const uriB1 = await createSpace(app, BOB);

    const res = await call(app, "POST", "/xrpc/test.man.space.getMembershipManifest", BOB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.manifest).toBeTypeOf("string");
    expect(body.expiresAt).toBeTypeOf("number");
    expect(body.truncated).toBe(false);

    // Verify signature + payload.
    const result = await verifyMembershipManifest(body.manifest, {
      resolveKey: async (iss) => (iss === SERVICE_DID ? SIGNING.publicKey : null),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.iss).toBe(SERVICE_DID);
      expect(result.claims.sub).toBe(BOB);
      expect(result.claims.spaces.sort()).toEqual([uriA1, uriB1].sort());
    }

    // Alice's membership shouldn't be visible to Bob's manifest.
    if (result.ok) expect(result.claims.spaces).not.toContain(uriA2);
  });

  it("returns an empty spaces array for a user with no memberships", async () => {
    const app = await makeApp();
    const res = await call(app, "POST", "/xrpc/test.man.space.getMembershipManifest", CHARLIE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const result = await verifyMembershipManifest(body.manifest, {
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.spaces).toEqual([]);
  });

  it("dedupes — owner who is also a member appears once", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    // createSpace internally addMembers the owner; both scopes will include it.
    const res = await call(app, "POST", "/xrpc/test.man.space.getMembershipManifest", ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const result = await verifyMembershipManifest(body.manifest, {
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.spaces).toEqual([uri]);
  });

  it("sets truncated:true when over manifestMaxSpaces", async () => {
    const cfg = makeConfig();
    cfg.spaces!.authority!.manifestMaxSpaces = 2;
    const app = await makeApp(cfg);
    await createSpace(app, ALICE);
    await createSpace(app, ALICE);
    await createSpace(app, ALICE);

    const res = await call(app, "POST", "/xrpc/test.man.space.getMembershipManifest", ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.truncated).toBe(true);
    const result = await verifyMembershipManifest(body.manifest, {
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.spaces.length).toBe(2);
  });

  it("requires auth", async () => {
    const app = await makeApp();
    const res = await call(app, "POST", "/xrpc/test.man.space.getMembershipManifest", null);
    expect(res.status).toBe(401);
  });

  it("returns 501 when authority is not configured to sign", async () => {
    const cfg = makeConfig();
    delete cfg.spaces!.authority!.signing;
    const app = await makeApp(cfg);
    const res = await call(app, "POST", "/xrpc/test.man.space.getMembershipManifest", ALICE);
    expect(res.status).toBe(501);
  });
});
