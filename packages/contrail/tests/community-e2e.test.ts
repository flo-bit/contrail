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
const PDS_ENDPOINT = "https://pds.example";

// 32-byte test master key (deterministic; not a real secret).
const MASTER_KEY = new Uint8Array(32).fill(7);

const CONFIG: ContrailConfig = {
  namespace: "test.comm",
  collections: {
    message: { collection: "app.event.message" },
  },
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:test.example#svc",
  },
  community: {
    masterKey: MASTER_KEY,
    // Fake network: hand-rolled below.
    fetch: mockFetch,
    resolver: mockResolver(),
  },
};

function mockResolver(): any {
  return {
    resolve: async (did: string) => {
      if (did !== COMMUNITY_DID) throw new Error("unknown did");
      return {
        id: did,
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: PDS_ENDPOINT,
          },
        ],
      };
    },
  };
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // Handle resolution paths are handled by the mock resolver, not fetch.
  if (url.endsWith("/xrpc/com.atproto.server.createSession") && init?.method === "POST") {
    const body = JSON.parse((init.body as string) ?? "{}");
    if (body.password === "app-password-ok") {
      return new Response(
        JSON.stringify({
          accessJwt: "a.b.c",
          refreshJwt: "r.r.r",
          did: COMMUNITY_DID,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "AuthFactorTokenRequired" }), { status: 401 });
  }
  return new Response("not found", { status: 404 });
}

function fakeAuth(): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", {
      issuer: did,
      audience: CONFIG.spaces!.serviceDid,
      lxm: undefined,
    });
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
  did: string | null,
  body?: any
): Promise<Response> {
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

async function adopt(app: Hono, caller: string) {
  const res = await call(app, "POST", "/xrpc/test.comm.community.adopt", caller, {
    identifier: COMMUNITY_DID,
    appPassword: "app-password-ok",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { communityDid: string };
  expect(body.communityDid).toBe(COMMUNITY_DID);
  return body.communityDid;
}

describe("community e2e — stage 1", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await makeApp();
  });

  it("adopts a community and creates reserved spaces with creator as owner", async () => {
    const did = await adopt(app, ALICE);

    const adminUri = `at://${did}/tools.atmo.event.space/$admin`;
    const publishersUri = `at://${did}/tools.atmo.event.space/$publishers`;

    // whoami in both reserved spaces → owner
    for (const uri of [adminUri, publishersUri]) {
      const r = await call(app, "GET", `/xrpc/test.comm.spaceExt.whoami?spaceUri=${encodeURIComponent(uri)}`, ALICE);
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).accessLevel).toBe("owner");
    }

    // Bob isn't in either
    const r = await call(app, "GET", `/xrpc/test.comm.spaceExt.whoami?spaceUri=${encodeURIComponent(adminUri)}`, BOB);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).accessLevel).toBe(null);
  });

  it("rejects bad credentials", async () => {
    const app2 = await makeApp();
    const res = await call(app2, "POST", "/xrpc/test.comm.community.adopt", ALICE, {
      identifier: COMMUNITY_DID,
      appPassword: "wrong",
    });
    expect(res.status).toBe(401);
  });

  it("rejects duplicate adoption", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.adopt", BOB, {
      identifier: COMMUNITY_DID,
      appPassword: "app-password-ok",
    });
    expect(res.status).toBe(409);
  });

  it("creates a non-reserved space via community.space.create", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.create", ALICE, {
      communityDid: COMMUNITY_DID,
      key: "general",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.space.uri).toBe(`at://${COMMUNITY_DID}/tools.atmo.event.space/general`);
    expect(body.space.ownerDid).toBe(COMMUNITY_DID);
  });

  it("rejects reserved keys in space.create", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.create", ALICE, {
      communityDid: COMMUNITY_DID,
      key: "$admin",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("reserved-key");
  });

  it("non-admin cannot create a space", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.create", BOB, {
      communityDid: COMMUNITY_DID,
      key: "random",
    });
    expect(res.status).toBe(403);
  });

  it("owner grants Bob member access to #general; reconciler populates spaces_members", async () => {
    const spaceUri = `at://${COMMUNITY_DID}/tools.atmo.event.space/general`;
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.grant", ALICE, {
      spaceUri,
      subject: { did: BOB },
      accessLevel: "member",
    });
    expect(res.status).toBe(200);

    // Bob can now see the members list
    const list = await call(
      app,
      "GET",
      `/xrpc/test.comm.community.space.listMembers?spaceUri=${encodeURIComponent(spaceUri)}`,
      BOB
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as any;
    expect(body.rows.map((r: any) => r.subject.did)).toContain(BOB);
  });

  it("manager cannot grant higher than own level", async () => {
    const spaceUri = `at://${COMMUNITY_DID}/tools.atmo.event.space/general`;
    // Promote Bob to manager
    await call(app, "POST", "/xrpc/test.comm.community.space.grant", ALICE, {
      spaceUri,
      subject: { did: BOB },
      accessLevel: "manager",
    });
    // Bob tries to grant Charlie owner — should fail
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.grant", BOB, {
      spaceUri,
      subject: { did: CHARLIE },
      accessLevel: "owner",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason).toBe("cannot-grant-higher-than-self");
  });

  it("grant cannot downgrade a subject who outranks the caller", async () => {
    const spaceUri = `at://${COMMUNITY_DID}/tools.atmo.event.space/general`;
    // Bob is currently manager (promoted earlier in this describe block).
    // Alice is owner of the space. Bob tries to downgrade Alice to member via grant.
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.grant", BOB, {
      spaceUri,
      subject: { did: ALICE },
      accessLevel: "member",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason).toBe("cannot-modify-higher-than-self");
  });

  it("revokes and reconciler removes from spaces_members", async () => {
    const spaceUri = `at://${COMMUNITY_DID}/tools.atmo.event.space/general`;
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.revoke", ALICE, {
      spaceUri,
      subject: { did: BOB },
    });
    expect(res.status).toBe(200);

    const level = await call(
      app,
      "GET",
      `/xrpc/test.comm.spaceExt.whoami?spaceUri=${encodeURIComponent(spaceUri)}`,
      BOB
    );
    expect(((await level.json()) as any).accessLevel).toBe(null);
  });

  it("cannot delete a reserved space", async () => {
    const adminUri = `at://${COMMUNITY_DID}/tools.atmo.event.space/$admin`;
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.delete", ALICE, {
      spaceUri: adminUri,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason).toBe("reserved-space-cannot-be-deleted");
  });

  it("lists communities for an actor", async () => {
    const res = await call(app, "GET", `/xrpc/test.comm.community.list`, ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.communities.map((c: any) => c.did)).toContain(COMMUNITY_DID);
  });
});
