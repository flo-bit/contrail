import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { initSchema } from "@atmo-dev/contrail";
import { createApp } from "@atmo-dev/contrail";
import { resolveConfig } from "@atmo-dev/contrail";
import type { ContrailConfig } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "../src/integration";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";
const COMMUNITY_DID = "did:plc:pubcomm";
const PDS_ENDPOINT = "https://pds.example";

const MASTER_KEY = new Uint8Array(32).fill(42);

/** Shared state for asserting PDS proxying happened. */
const pdsCalls: Array<{ url: string; body: any }> = [];

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
  const body = init?.body ? JSON.parse(init.body as string) : {};
  pdsCalls.push({ url, body });
  if (url.endsWith("/xrpc/com.atproto.server.createSession")) {
    if (body.password === "correct-pw" || body.password === "new-correct-pw") {
      return new Response(
        JSON.stringify({ accessJwt: "a.b.c", refreshJwt: "r.r.r", did: COMMUNITY_DID }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "AuthFailed" }), { status: 401 });
  }
  if (url.endsWith("/xrpc/com.atproto.repo.createRecord")) {
    return new Response(
      JSON.stringify({
        uri: `at://${COMMUNITY_DID}/${body.collection}/fakerkey`,
        cid: "bafyfake",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url.endsWith("/xrpc/com.atproto.repo.deleteRecord")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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
  const community = createCommunityIntegration({ db, config: resolved });
  await initSchema(db, resolved, { extraSchemas: [community.applySchema] });
  return createApp(db, resolved, {
    spaces: { authMiddleware: fakeAuth() },
    community,
  });
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

async function adopt(app: Hono, caller: string, password: string) {
  const res = await call(app, "POST", "/xrpc/test.comm.community.adopt", caller, {
    identifier: COMMUNITY_DID,
    appPassword: password,
  });
  expect(res.status).toBe(200);
}

async function grant(app: Hono, caller: string, spaceUri: string, subject: any, accessLevel: string) {
  const res = await call(app, "POST", "/xrpc/test.comm.community.space.grant", caller, {
    spaceUri,
    subject,
    accessLevel,
  });
  expect(res.status).toBe(200);
  return res;
}

describe("community publishing + reauth — stage 3", () => {
  let app: Hono;
  const publishers = `ats://${COMMUNITY_DID}/tools.atmo.event.space/$publishers`;
  const admin = `ats://${COMMUNITY_DID}/tools.atmo.event.space/$admin`;

  beforeAll(async () => {
    app = await makeApp();
    await adopt(app, ALICE, "correct-pw");
  });

  it("community.putRecord proxies to PDS for a $publishers member", async () => {
    // Alice is already owner of $publishers from bootstrap; add Bob as plain member.
    await grant(app, ALICE, publishers, { did: BOB }, "member");

    const before = pdsCalls.length;
    const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", BOB, {
      communityDid: COMMUNITY_DID,
      collection: "app.event.message",
      record: { text: "hello from the community" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.uri).toMatch(/^at:\/\//);

    const newCalls = pdsCalls.slice(before);
    expect(newCalls.some((c) => c.url.endsWith("/xrpc/com.atproto.server.createSession"))).toBe(true);
    expect(newCalls.some((c) => c.url.endsWith("/xrpc/com.atproto.repo.createRecord"))).toBe(true);
  });

  it("non-$publishers member cannot putRecord", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", CHARLIE, {
      communityDid: COMMUNITY_DID,
      collection: "app.event.message",
      record: { text: "nope" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason).toBe("not-in-publishers");
  });

  it("community.space.putRecord writes in-space with community author (admin+ required)", async () => {
    // Create a content space.
    const createRes = await call(app, "POST", "/xrpc/test.comm.community.space.create", ALICE, {
      communityDid: COMMUNITY_DID,
      key: "announcements",
    });
    expect(createRes.status).toBe(200);
    const spaceUri = ((await createRes.json()) as any).space.uri;

    // Alice (owner, which ≥ admin) writes.
    const put = await call(app, "POST", "/xrpc/test.comm.community.space.putRecord", ALICE, {
      spaceUri,
      collection: "app.event.message",
      record: { text: "first post" },
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as any;
    expect(body.authorDid).toBe(COMMUNITY_DID);
  });

  it("community.space.putRecord rejects non-admin members", async () => {
    const createRes = await call(app, "POST", "/xrpc/test.comm.community.space.create", ALICE, {
      communityDid: COMMUNITY_DID,
      key: "ann2",
    });
    const spaceUri = ((await createRes.json()) as any).space.uri;
    await grant(app, ALICE, spaceUri, { did: BOB }, "member");

    const put = await call(app, "POST", "/xrpc/test.comm.community.space.putRecord", BOB, {
      spaceUri,
      collection: "app.event.message",
      record: { text: "nope" },
    });
    expect(put.status).toBe(403);
  });

  it("setAccessLevel with rank-outranking", async () => {
    const createRes = await call(app, "POST", "/xrpc/test.comm.community.space.create", ALICE, {
      communityDid: COMMUNITY_DID,
      key: "roles-test",
    });
    const spaceUri = ((await createRes.json()) as any).space.uri;
    await grant(app, ALICE, spaceUri, { did: BOB }, "manager");
    await grant(app, ALICE, spaceUri, { did: CHARLIE }, "member");

    // Bob (manager) promotes Charlie to manager — OK.
    const ok = await call(app, "POST", "/xrpc/test.comm.community.space.setAccessLevel", BOB, {
      spaceUri,
      subject: { did: CHARLIE },
      accessLevel: "manager",
    });
    expect(ok.status).toBe(200);

    // Bob (manager) tries to promote Charlie to admin — rejected.
    const nope = await call(app, "POST", "/xrpc/test.comm.community.space.setAccessLevel", BOB, {
      spaceUri,
      subject: { did: CHARLIE },
      accessLevel: "admin",
    });
    expect(nope.status).toBe(403);
  });

  it("getHealth reports healthy", async () => {
    const res = await call(app, "GET", `/xrpc/test.comm.community.getHealth?communityDid=${COMMUNITY_DID}`, ALICE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("healthy");
  });

  it("reauth replaces the stored app password; old password no longer works", async () => {
    const reauth = await call(app, "POST", "/xrpc/test.comm.community.reauth", ALICE, {
      communityDid: COMMUNITY_DID,
      appPassword: "new-correct-pw",
    });
    expect(reauth.status).toBe(200);

    // getHealth still works with the new stored password.
    const health = await call(app, "GET", `/xrpc/test.comm.community.getHealth?communityDid=${COMMUNITY_DID}`, ALICE);
    expect(((await health.json()) as any).status).toBe("healthy");
  });

  it("reauth requires owner in $admin", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.reauth", BOB, {
      communityDid: COMMUNITY_DID,
      appPassword: "correct-pw",
    });
    expect(res.status).toBe(403);
  });

  it("reauth with bad credentials is rejected", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.reauth", ALICE, {
      communityDid: COMMUNITY_DID,
      appPassword: "totally-wrong",
    });
    expect(res.status).toBe(401);
  });
});
