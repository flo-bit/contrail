/** Unified invite surface: `<ns>.invite.*` dispatches on space ownership.
 *   - user-owned space   → `kind` in create, `addMember` on redeem.
 *   - community-owned    → `accessLevel` in create, `grant`+`reconcile` on redeem.
 *
 *  Both paths through a single endpoint family. */

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";
const COMMUNITY_DID = "did:plc:acmecommunity";
const PDS = "https://pds.example";
const MASTER_KEY = new Uint8Array(32).fill(11);

const CONFIG: ContrailConfig = {
  namespace: "test.inv",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    authority: { type: "tools.atmo.event.space", serviceDid: "did:web:test.example#svc" },
    recordHost: {},
  },
  community: {
    masterKey: MASTER_KEY,
    fetch: mockFetch,
    resolver: mockResolver(),
  },
};

function mockResolver(): any {
  return {
    resolve: async (_did: string) => ({
      id: _did,
      service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }],
    }),
  };
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/xrpc/com.atproto.server.createSession") && init?.method === "POST") {
    return new Response(
      JSON.stringify({ accessJwt: "a.b.c", refreshJwt: "r.r.r", did: COMMUNITY_DID }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
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

function call(app: Hono, method: string, path: string, did: string, body?: any): Promise<Response> {
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

describe("<ns>.invite.* — unified surface", () => {
  describe("user-owned space (kind)", () => {
    let app: Hono;
    let spaceUri: string;

    beforeAll(async () => {
      app = await makeApp();
      const res = await call(app, "POST", "/xrpc/test.inv.space.createSpace", ALICE, { key: "lounge" });
      expect(res.status).toBe(200);
      spaceUri = ((await res.json()) as any).space.uri;
    });

    it("rejects accessLevel on a user-owned space", async () => {
      const res = await call(app, "POST", "/xrpc/test.inv.invite.create", ALICE, {
        spaceUri,
        accessLevel: "member",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).reason).toBe("accessLevel-on-user-space");
    });

    it("owner creates kind=join; redeemer becomes a member", async () => {
      const create = await call(app, "POST", "/xrpc/test.inv.invite.create", ALICE, { spaceUri });
      expect(create.status).toBe(200);
      const { token, invite } = (await create.json()) as any;
      expect(invite.kind).toBe("join");
      expect(invite.accessLevel).toBeUndefined();

      const redeem = await call(app, "POST", "/xrpc/test.inv.invite.redeem", BOB, { token });
      expect(redeem.status).toBe(200);
      const body = (await redeem.json()) as any;
      expect(body.spaceUri).toBe(spaceUri);
      expect(body.kind).toBe("join");
      expect(body.accessLevel).toBeUndefined();
    });
  });

  describe("community-owned space (accessLevel)", () => {
    let app: Hono;
    let adminUri: string;
    let channelUri: string;

    beforeAll(async () => {
      app = await makeApp();
      // Adopt a community owned by Alice.
      const adopt = await call(app, "POST", "/xrpc/test.inv.community.adopt", ALICE, {
        identifier: COMMUNITY_DID,
        appPassword: "anything",
      });
      expect(adopt.status).toBe(200);
      adminUri = `ats://${COMMUNITY_DID}/tools.atmo.event.space/$admin`;

      // Alice (owner in $admin) creates a child space.
      const create = await call(app, "POST", "/xrpc/test.inv.community.space.create", ALICE, {
        communityDid: COMMUNITY_DID,
        key: "general",
      });
      expect(create.status).toBe(200);
      channelUri = ((await create.json()) as any).space.uri;
    });

    it("rejects kind on a community-owned space", async () => {
      const res = await call(app, "POST", "/xrpc/test.inv.invite.create", ALICE, {
        spaceUri: channelUri,
        kind: "join",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).reason).toBe("kind-on-community-space");
    });

    it("requires accessLevel", async () => {
      const res = await call(app, "POST", "/xrpc/test.inv.invite.create", ALICE, {
        spaceUri: channelUri,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).reason).toBe("accessLevel-required");
    });

    it("owner creates with accessLevel=member; redeemer is granted that level", async () => {
      const create = await call(app, "POST", "/xrpc/test.inv.invite.create", ALICE, {
        spaceUri: channelUri,
        accessLevel: "member",
      });
      expect(create.status).toBe(200);
      const { token, invite } = (await create.json()) as any;
      expect(invite.accessLevel).toBe("member");
      expect(invite.kind).toBeUndefined();

      const redeem = await call(app, "POST", "/xrpc/test.inv.invite.redeem", BOB, { token });
      expect(redeem.status).toBe(200);
      const body = (await redeem.json()) as any;
      expect(body.spaceUri).toBe(channelUri);
      expect(body.accessLevel).toBe("member");
      expect(body.communityDid).toBe(COMMUNITY_DID);

      // Bob now shows up on whoami via the ladder.
      const w = await call(app, "GET", `/xrpc/test.inv.spaceExt.whoami?spaceUri=${encodeURIComponent(channelUri)}`, BOB);
      expect(((await w.json()) as any).accessLevel).toBe("member");
    });

    it("non-manager cannot create an invite on a community space", async () => {
      const res = await call(app, "POST", "/xrpc/test.inv.invite.create", CHARLIE, {
        spaceUri: channelUri,
        accessLevel: "member",
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).reason).toBe("manager-required");
    });

    it("cannot grant a higher access level than caller's own", async () => {
      // Create a second space. Grant Charlie as "manager" there, then have him
      // try to mint an "admin" invite — should fail.
      const create = await call(app, "POST", "/xrpc/test.inv.community.space.create", ALICE, {
        communityDid: COMMUNITY_DID,
        key: "side",
      });
      const sideUri = ((await create.json()) as any).space.uri;
      await call(app, "POST", "/xrpc/test.inv.community.space.grant", ALICE, {
        spaceUri: sideUri,
        subject: { did: CHARLIE },
        accessLevel: "manager",
      });

      const res = await call(app, "POST", "/xrpc/test.inv.invite.create", CHARLIE, {
        spaceUri: sideUri,
        accessLevel: "admin",
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).reason).toBe("cannot-grant-higher-than-self");
    });
  });
});
