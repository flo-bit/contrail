import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig, Database } from "../src/core/types";
import { CommunityAdapter, CredentialCipher, RESERVED_KEYS } from "../src/core/community";
import { HostedAdapter } from "../src/core/spaces/adapter";
import { buildSpaceUri } from "../src/core/spaces/uri";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";
const COMMUNITY_DID = "did:plc:pubcomm";
const PROVISION_COMMUNITY_DID = "did:plc:provcomm";
const PROVISION_HANDLE = "provcomm.pds.test";
const PDS_ENDPOINT = "https://pds.example";

const MASTER_KEY = new Uint8Array(32).fill(42);

/** Shared state for asserting PDS proxying happened. */
const pdsCalls: Array<{ url: string; body: any }> = [];

const CONFIG: ContrailConfig = {
  namespace: "test.comm",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:test.example#svc",
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
      if (did !== COMMUNITY_DID && did !== PROVISION_COMMUNITY_DID) {
        throw new Error("unknown did");
      }
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
      // Echo back a DID that matches the identifier so adopt and provision flows
      // both look right to any caller checking session.did.
      const did =
        body.identifier === PROVISION_HANDLE ? PROVISION_COMMUNITY_DID : COMMUNITY_DID;
      return new Response(
        JSON.stringify({ accessJwt: "a.b.c", refreshJwt: "r.r.r", did }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "AuthFailed" }), { status: 401 });
  }
  if (url.endsWith("/xrpc/com.atproto.repo.createRecord")) {
    return new Response(
      JSON.stringify({
        uri: `at://${body.repo}/${body.collection}/fakerkey`,
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
    c.set("serviceAuth", { issuer: did, audience: CONFIG.spaces!.serviceDid, lxm: undefined });
    await next();
  };
}

async function makeApp(): Promise<{ app: Hono; db: Database }> {
  const db = createSqliteDatabase(":memory:");
  const resolved = resolveConfig(CONFIG);
  await initSchema(db, resolved);
  const app = createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
  return { app, db };
}

/** Seed a provision-mode community + its reserved spaces with `creator` as
 *  owner. Mirrors what the adopt/provision routes do via `bootstrapReservedSpaces`,
 *  but skips the route so we don't have to mock PLC + 5 PDS RPCs. */
async function seedProvisionCommunity(
  db: Database,
  creator: string,
  password: string
): Promise<void> {
  const cipher = new CredentialCipher(MASTER_KEY);
  const encrypted = await cipher.encrypt(password);
  const community = new CommunityAdapter(db);
  const spaces = new HostedAdapter(db, resolveConfig(CONFIG));
  await community.createFromProvisioned({
    did: PROVISION_COMMUNITY_DID,
    pdsEndpoint: PDS_ENDPOINT,
    handle: PROVISION_HANDLE,
    appPasswordEncrypted: encrypted,
    createdBy: creator,
  });
  for (const key of RESERVED_KEYS) {
    const uri = buildSpaceUri({
      ownerDid: PROVISION_COMMUNITY_DID,
      type: CONFIG.spaces!.type,
      key,
    });
    await spaces.createSpace({
      uri,
      ownerDid: PROVISION_COMMUNITY_DID,
      type: CONFIG.spaces!.type,
      key,
      serviceDid: CONFIG.spaces!.serviceDid,
      appPolicyRef: null,
      appPolicy: null,
    });
    await community.grant({
      spaceUri: uri,
      subjectDid: creator,
      accessLevel: "owner",
      grantedBy: creator,
    });
    await spaces.applyMembershipDiff(uri, [creator], [], creator);
  }
}

async function call(
  app: Hono,
  method: string,
  path: string,
  did: string,
  body?: any
): Promise<Response> {
  const headers: Record<string, string> = { "X-Test-Did": did };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return await app.fetch(
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
    ({ app } = await makeApp());
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

// Build a small base64url-encoded JWT with a given exp claim. The publishing
// path decodes payload.exp to decide whether to reuse a cached session.
function jwtWithExp(expSeconds: number): string {
  // base64url("{}") padding stripped — header content irrelevant to our tests.
  const header = "eyJhbGciOiJIUzI1NiJ9";
  const payloadJson = JSON.stringify({ exp: expSeconds });
  const payload = btoa(payloadJson)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.sig`;
}

/** Build an isolated app with a per-test scenario fetch + a fresh provision
 *  community. The scenario fetch records every call with its url + body +
 *  authorization header so individual tests can assert exact behavior. */
async function makeScenarioApp(scenario: {
  /** Override response for createSession. Default: success with default JWT. */
  onCreateSession?: () => Response;
  /** Override response for refreshSession. Default: 400 (no refresh). */
  onRefreshSession?: () => Response;
}): Promise<{
  app: Hono;
  db: Database;
  calls: Array<{ url: string; body: any; authorization: string | null }>;
}> {
  const calls: Array<{ url: string; body: any; authorization: string | null }> = [];
  const scenarioFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    const authorization = headers.get("authorization");
    calls.push({ url, body, authorization });
    if (url.endsWith("/xrpc/com.atproto.server.createSession")) {
      if (scenario.onCreateSession) return scenario.onCreateSession();
      return new Response(
        JSON.stringify({
          accessJwt: jwtWithExp(Math.floor(Date.now() / 1000) + 3600),
          refreshJwt: "r.r.r",
          did: PROVISION_COMMUNITY_DID,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/xrpc/com.atproto.server.refreshSession")) {
      if (scenario.onRefreshSession) return scenario.onRefreshSession();
      return new Response(JSON.stringify({ error: "ExpiredToken" }), { status: 400 });
    }
    if (url.endsWith("/xrpc/com.atproto.repo.createRecord")) {
      return new Response(
        JSON.stringify({
          uri: `at://${body.repo}/${body.collection}/scenkey`,
          cid: "bafyfake",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/xrpc/com.atproto.repo.deleteRecord")) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const cfg: ContrailConfig = {
    ...CONFIG,
    community: { ...CONFIG.community!, fetch: scenarioFetch },
  };
  const db = createSqliteDatabase(":memory:");
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);
  const app = createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
  // Seed provision community + Alice as owner of $publishers.
  const cipher = new CredentialCipher(MASTER_KEY);
  const encrypted = await cipher.encrypt("correct-pw");
  const community = new CommunityAdapter(db);
  const spacesAdp = new HostedAdapter(db, resolved);
  await community.createFromProvisioned({
    did: PROVISION_COMMUNITY_DID,
    pdsEndpoint: PDS_ENDPOINT,
    handle: PROVISION_HANDLE,
    appPasswordEncrypted: encrypted,
    createdBy: ALICE,
  });
  for (const key of RESERVED_KEYS) {
    const uri = buildSpaceUri({
      ownerDid: PROVISION_COMMUNITY_DID,
      type: CONFIG.spaces!.type,
      key,
    });
    await spacesAdp.createSpace({
      uri,
      ownerDid: PROVISION_COMMUNITY_DID,
      type: CONFIG.spaces!.type,
      key,
      serviceDid: CONFIG.spaces!.serviceDid,
      appPolicyRef: null,
      appPolicy: null,
    });
    await community.grant({
      spaceUri: uri,
      subjectDid: ALICE,
      accessLevel: "owner",
      grantedBy: ALICE,
    });
    await spacesAdp.applyMembershipDiff(uri, [ALICE], [], ALICE);
  }
  return { app, db, calls };
}

describe("community publishing — session caching (Task 14)", () => {
  it("caches PDS sessions across putRecord calls", async () => {
    const { app, calls } = await makeScenarioApp({});

    for (let i = 0; i < 3; i++) {
      const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", ALICE, {
        communityDid: PROVISION_COMMUNITY_DID,
        collection: "app.event.message",
        record: { text: `msg ${i}` },
      });
      expect(res.status).toBe(200);
    }

    const createSessionCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.server.createSession")
    ).length;
    const createRecordCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.repo.createRecord")
    ).length;
    expect(createSessionCalls).toBe(1);
    expect(createRecordCalls).toBe(3);
  });

  it("considers a session valid when accessExp is in the future", async () => {
    const { app, db, calls } = await makeScenarioApp({});
    // Pre-seed cache with a clearly-future expiry.
    const community = new CommunityAdapter(db);
    const cachedAccess = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    await community.upsertSession(PROVISION_COMMUNITY_DID, {
      accessJwt: cachedAccess,
      refreshJwt: "cached-refresh",
      accessExp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", ALICE, {
      communityDid: PROVISION_COMMUNITY_DID,
      collection: "app.event.message",
      record: { text: "uses cached session" },
    });
    expect(res.status).toBe(200);

    const createSessionCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.server.createSession")
    ).length;
    expect(createSessionCalls).toBe(0);
    // The createRecord call must have used the cached accessJwt.
    const cr = calls.find((c) => c.url.endsWith("/xrpc/com.atproto.repo.createRecord"));
    expect(cr).toBeDefined();
    expect(cr!.authorization).toBe(`Bearer ${cachedAccess}`);
  });

  it("refreshes a near-expired session via refreshSession", async () => {
    const refreshedAccess = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const { app, db, calls } = await makeScenarioApp({
      onRefreshSession: () =>
        new Response(
          JSON.stringify({ accessJwt: refreshedAccess, refreshJwt: "new-refresh" }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    });
    const community = new CommunityAdapter(db);
    await community.upsertSession(PROVISION_COMMUNITY_DID, {
      accessJwt: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
      refreshJwt: "old-refresh",
      accessExp: Math.floor(Date.now() / 1000) - 60,
    });

    const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", ALICE, {
      communityDid: PROVISION_COMMUNITY_DID,
      collection: "app.event.message",
      record: { text: "after refresh" },
    });
    expect(res.status).toBe(200);

    const createSessionCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.server.createSession")
    ).length;
    const refreshSessionCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.server.refreshSession")
    ).length;
    expect(createSessionCalls).toBe(0);
    expect(refreshSessionCalls).toBe(1);
    // createRecord must use the refreshed access JWT.
    const cr = calls.find((c) => c.url.endsWith("/xrpc/com.atproto.repo.createRecord"));
    expect(cr!.authorization).toBe(`Bearer ${refreshedAccess}`);
  });

  it("falls back to createSession when refresh fails", async () => {
    const { app, db, calls } = await makeScenarioApp({
      onRefreshSession: () =>
        new Response(JSON.stringify({ error: "ExpiredToken" }), { status: 400 }),
    });
    const community = new CommunityAdapter(db);
    await community.upsertSession(PROVISION_COMMUNITY_DID, {
      accessJwt: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
      refreshJwt: "stale-refresh",
      accessExp: Math.floor(Date.now() / 1000) - 60,
    });

    const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", ALICE, {
      communityDid: PROVISION_COMMUNITY_DID,
      collection: "app.event.message",
      record: { text: "fallback to create" },
    });
    expect(res.status).toBe(200);

    const createSessionCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.server.createSession")
    ).length;
    const refreshSessionCalls = calls.filter((c) =>
      c.url.endsWith("/xrpc/com.atproto.server.refreshSession")
    ).length;
    expect(refreshSessionCalls).toBe(1);
    expect(createSessionCalls).toBe(1);
  });
});

describe("community publishing — provision mode", () => {
  let app: Hono;

  beforeAll(async () => {
    const built = await makeApp();
    app = built.app;
    await seedProvisionCommunity(built.db, ALICE, "correct-pw");
  });

  it("publishes a record under a provision-mode community", async () => {
    const before = pdsCalls.length;
    const res = await call(app, "POST", "/xrpc/test.comm.community.putRecord", ALICE, {
      communityDid: PROVISION_COMMUNITY_DID,
      collection: "app.event.message",
      record: { text: "hello from a provisioned community" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.uri).toBe(`at://${PROVISION_COMMUNITY_DID}/app.event.message/fakerkey`);

    const newCalls = pdsCalls.slice(before);
    expect(
      newCalls.some(
        (c) =>
          c.url.endsWith("/xrpc/com.atproto.server.createSession") &&
          c.body.identifier === PROVISION_HANDLE
      )
    ).toBe(true);
    expect(
      newCalls.some(
        (c) =>
          c.url.endsWith("/xrpc/com.atproto.repo.createRecord") &&
          c.body.repo === PROVISION_COMMUNITY_DID
      )
    ).toBe(true);
  });

  it("deletes a record under a provision-mode community", async () => {
    const before = pdsCalls.length;
    const res = await call(app, "POST", "/xrpc/test.comm.community.deleteRecord", ALICE, {
      communityDid: PROVISION_COMMUNITY_DID,
      collection: "app.event.message",
      rkey: "fakerkey",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);

    const newCalls = pdsCalls.slice(before);
    expect(
      newCalls.some((c) => c.url.endsWith("/xrpc/com.atproto.repo.deleteRecord"))
    ).toBe(true);
  });

  it("reports healthy for a provision-mode community", async () => {
    const res = await call(
      app,
      "GET",
      `/xrpc/test.comm.community.getHealth?communityDid=${PROVISION_COMMUNITY_DID}`,
      ALICE
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("healthy");
  });
});
