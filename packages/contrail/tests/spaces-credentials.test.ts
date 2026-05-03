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
  signCredential,
  verifyCredential,
  issueCredential,
} from "../src/core/spaces/credentials";
import type { CredentialKeyMaterial } from "../src/core/spaces/credentials";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";

const SERVICE_DID = "did:web:test.example#svc";

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

function makeConfig(): ContrailConfig {
  return {
    namespace: "test.cred",
    collections: {
      message: { collection: "app.event.message" },
    },
    spaces: {
      authority: {
        type: "tools.atmo.event.space",
        serviceDid: SERVICE_DID,
        signing: SIGNING,
        credentialTtlMs: 60_000,
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

async function makeApp(): Promise<Hono> {
  const db = createSqliteDatabase(":memory:");
  const cfg = makeConfig();
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);
  return createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
}

function call(
  app: Hono,
  method: string,
  path: string,
  did: string | null,
  body?: any,
  extraHeaders?: Record<string, string>
) {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
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
  const res = await call(app, "POST", "/xrpc/test.cred.space.createSpace", owner, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as any).space.uri;
}

async function getCredential(app: Hono, did: string, spaceUri: string): Promise<string> {
  const res = await call(app, "POST", "/xrpc/test.cred.space.getCredential", did, { spaceUri });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).credential;
}

describe("space credentials — sign/verify primitives", () => {
  it("round-trips via verifyCredential", async () => {
    const { credential } = await issueCredential(
      {
        iss: SERVICE_DID,
        sub: ALICE,
        space: "ats://did:plc:alice/test/main",
        scope: "rw",
        ttlMs: 60_000,
      },
      SIGNING
    );
    const result = await verifyCredential(credential, {
      expectedSpace: "ats://did:plc:alice/test/main",
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.iss).toBe(SERVICE_DID);
      expect(result.claims.sub).toBe(ALICE);
      expect(result.claims.scope).toBe("rw");
    }
  });

  it("rejects expired credentials", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const credential = await signCredential(
      {
        iss: SERVICE_DID,
        sub: ALICE,
        space: "ats://x/y/z",
        scope: "rw",
        iat: past - 60,
        exp: past,
      },
      SIGNING
    );
    const result = await verifyCredential(credential, {
      expectedSpace: "ats://x/y/z",
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects wrong-space credentials", async () => {
    const { credential } = await issueCredential(
      { iss: SERVICE_DID, sub: ALICE, space: "ats://a/b/c", scope: "rw", ttlMs: 60_000 },
      SIGNING
    );
    const result = await verifyCredential(credential, {
      expectedSpace: "ats://different/space/here",
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-space");
  });

  it("rejects credentials signed by a different key", async () => {
    const { credential } = await issueCredential(
      { iss: SERVICE_DID, sub: ALICE, space: "ats://x/y/z", scope: "rw", ttlMs: 60_000 },
      SIGNING
    );
    const otherKey = await generateAuthoritySigningKey();
    const result = await verifyCredential(credential, {
      expectedSpace: "ats://x/y/z",
      resolveKey: async () => otherKey.publicKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects unknown issuer", async () => {
    const { credential } = await issueCredential(
      { iss: SERVICE_DID, sub: ALICE, space: "ats://x/y/z", scope: "rw", ttlMs: 60_000 },
      SIGNING
    );
    const result = await verifyCredential(credential, {
      expectedSpace: "ats://x/y/z",
      resolveKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-issuer");
  });

  it("scope=rw rejects read-only credentials when verifier requires rw", async () => {
    const { credential } = await issueCredential(
      { iss: SERVICE_DID, sub: ALICE, space: "ats://x/y/z", scope: "read", ttlMs: 60_000 },
      SIGNING
    );
    const result = await verifyCredential(credential, {
      expectedSpace: "ats://x/y/z",
      requiredScope: "rw",
      resolveKey: async () => SIGNING.publicKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-scope");
  });
});

describe("space credentials — getCredential / refreshCredential endpoints", () => {
  it("issues a credential for a space owner", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const res = await call(app, "POST", "/xrpc/test.cred.space.getCredential", ALICE, {
      spaceUri: uri,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.credential).toBeTypeOf("string");
    expect(body.expiresAt).toBeTypeOf("number");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("issues a credential for a member who isn't the owner", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    await call(app, "POST", "/xrpc/test.cred.space.addMember", ALICE, {
      spaceUri: uri,
      did: BOB,
    });
    const res = await call(app, "POST", "/xrpc/test.cred.space.getCredential", BOB, {
      spaceUri: uri,
    });
    expect(res.status).toBe(200);
  });

  it("denies non-members", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const res = await call(app, "POST", "/xrpc/test.cred.space.getCredential", CHARLIE, {
      spaceUri: uri,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not-member");
  });

  it("refreshes an unexpired credential", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const cred = await getCredential(app, ALICE, uri);

    const res = await call(app, "POST", "/xrpc/test.cred.space.refreshCredential", null, {
      credential: cred,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.credential).toBeTypeOf("string");
    expect(body.credential).not.toBe(cred); // fresh iat/exp → different signature
  });

  it("refresh rejects when the holder is no longer a member", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    await call(app, "POST", "/xrpc/test.cred.space.addMember", ALICE, {
      spaceUri: uri,
      did: BOB,
    });
    const cred = await getCredential(app, BOB, uri);
    // Owner kicks Bob out.
    const removeRes = await call(app, "POST", "/xrpc/test.cred.space.removeMember", ALICE, {
      spaceUri: uri,
      did: BOB,
    });
    expect(removeRes.status).toBe(200);

    const res = await call(app, "POST", "/xrpc/test.cred.space.refreshCredential", null, {
      credential: cred,
    });
    expect(res.status).toBe(403);
  });
});

describe("space credentials — record host accepts X-Space-Credential", () => {
  it("putRecord works with a credential and no service-auth JWT", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const cred = await getCredential(app, ALICE, uri);

    const res = await call(
      app,
      "POST",
      "/xrpc/test.cred.space.putRecord",
      null, // no X-Test-Did header
      {
        spaceUri: uri,
        collection: "app.event.message",
        record: { $type: "app.event.message", text: "hi from credential" },
      },
      { "X-Space-Credential": cred }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.authorDid).toBe(ALICE);
    expect(body.rkey).toBeTypeOf("string");
  });

  it("listRecords works with a credential", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const cred = await getCredential(app, ALICE, uri);
    // Plant a record via the JWT path so listRecords has something to return.
    await call(
      app,
      "POST",
      "/xrpc/test.cred.space.putRecord",
      ALICE,
      {
        spaceUri: uri,
        collection: "app.event.message",
        record: { $type: "app.event.message", text: "one" },
      }
    );

    const res = await call(
      app,
      "GET",
      `/xrpc/test.cred.space.listRecords?spaceUri=${encodeURIComponent(uri)}&collection=app.event.message`,
      null,
      undefined,
      { "X-Space-Credential": cred }
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).records.length).toBe(1);
  });

  it("rejects credential issued for a different space", async () => {
    const app = await makeApp();
    const uriA = await createSpace(app, ALICE);
    // Alice can create a second one; key auto-generated, owner is implicit member.
    const uriB = await createSpace(app, ALICE);
    const credForA = await getCredential(app, ALICE, uriA);

    const res = await call(
      app,
      "POST",
      "/xrpc/test.cred.space.putRecord",
      null,
      {
        spaceUri: uriB,
        collection: "app.event.message",
        record: { $type: "app.event.message", text: "wrong space" },
      },
      { "X-Space-Credential": credForA }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("credential-wrong-space");
  });

  it("rejects malformed credentials", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const res = await call(
      app,
      "POST",
      "/xrpc/test.cred.space.putRecord",
      null,
      {
        spaceUri: uri,
        collection: "app.event.message",
        record: { $type: "app.event.message", text: "x" },
      },
      { "X-Space-Credential": "not-a-jwt" }
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("malformed");
  });

  it("rejects credentials forged with an unknown issuer", async () => {
    const app = await makeApp();
    const uri = await createSpace(app, ALICE);
    const otherKey = await generateAuthoritySigningKey();
    const { credential } = await issueCredential(
      {
        iss: "did:web:attacker.example",
        sub: ALICE,
        space: uri,
        scope: "rw",
        ttlMs: 60_000,
      },
      otherKey
    );
    const res = await call(
      app,
      "POST",
      "/xrpc/test.cred.space.putRecord",
      null,
      {
        spaceUri: uri,
        collection: "app.event.message",
        record: { $type: "app.event.message", text: "x" },
      },
      { "X-Space-Credential": credential }
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("unknown-issuer");
  });
});
