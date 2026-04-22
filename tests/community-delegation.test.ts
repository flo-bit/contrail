import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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
const DIANA = "did:plc:diana";
const COMMUNITY_DID = "did:plc:acme";
const PDS_ENDPOINT = "https://pds.example";

const MASTER_KEY = new Uint8Array(32).fill(11);

const CONFIG: ContrailConfig = {
  namespace: "test.comm",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:test.example#svc",
  },
  community: {
    masterKey: MASTER_KEY,
    plcDirectory: "https://plc.test",
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
  if (url.endsWith("/xrpc/com.atproto.server.createSession") && init?.method === "POST") {
    return new Response(
      JSON.stringify({ accessJwt: "a.b.c", refreshJwt: "r.r.r", did: COMMUNITY_DID }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  // PLC directory submissions for community.mint.
  if (url.startsWith("https://plc.test/")) {
    return new Response("{}", { status: 200 });
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

async function adopt(app: Hono, caller: string) {
  const res = await call(app, "POST", "/xrpc/test.comm.community.adopt", caller, {
    identifier: COMMUNITY_DID,
    appPassword: "ok",
  });
  expect(res.status).toBe(200);
}

async function createSpace(app: Hono, caller: string, key: string): Promise<string> {
  const res = await call(app, "POST", "/xrpc/test.comm.community.space.create", caller, {
    communityDid: COMMUNITY_DID,
    key,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).space.uri;
}

async function grant(app: Hono, caller: string, spaceUri: string, subject: any, accessLevel: string) {
  const res = await call(app, "POST", "/xrpc/test.comm.community.space.grant", caller, {
    spaceUri,
    subject,
    accessLevel,
  });
  return res;
}

async function whoamiLevel(app: Hono, caller: string, spaceUri: string): Promise<string | null> {
  const res = await call(app, "GET", `/xrpc/test.comm.community.whoami?spaceUri=${encodeURIComponent(spaceUri)}`, caller);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).accessLevel;
}

async function flatMembers(app: Hono, caller: string, spaceUri: string): Promise<string[]> {
  const res = await call(
    app,
    "GET",
    `/xrpc/test.comm.community.space.listMembers?spaceUri=${encodeURIComponent(spaceUri)}&flatten=true`,
    caller
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as any).members.map((m: any) => m.did);
}

describe("community delegation — stage 2", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await makeApp();
    await adopt(app, ALICE);
  });

  it("subject_space_uri delegates membership from one space to another", async () => {
    const mods = await createSpace(app, ALICE, "mods");
    const chat = await createSpace(app, ALICE, "mod-chat");

    // Bob is a member of mods.
    expect((await grant(app, ALICE, mods, { did: BOB }, "member")).status).toBe(200);
    // mods is a member of mod-chat.
    expect((await grant(app, ALICE, chat, { spaceUri: mods }, "member")).status).toBe(200);

    // Bob is transitively a member of mod-chat.
    expect(await whoamiLevel(app, BOB, chat)).toBe("member");
    const flat = await flatMembers(app, ALICE, chat);
    expect(flat).toContain(BOB);
    expect(flat).toContain(ALICE); // owner
  });

  it("access is capped at the path minimum (delegation can only reduce)", async () => {
    const mods = await createSpace(app, ALICE, "mods2");
    const target = await createSpace(app, ALICE, "target2");

    // Bob is an owner of mods2.
    expect((await grant(app, ALICE, mods, { did: BOB }, "owner")).status).toBe(200);
    // mods2 is a `member` of target2 (capped path).
    expect((await grant(app, ALICE, target, { spaceUri: mods }, "member")).status).toBe(200);

    // Bob's effective level in target2 is `member`, not `owner`.
    expect(await whoamiLevel(app, BOB, target)).toBe("member");
  });

  it("cycle detection rejects A → B → A", async () => {
    const a = await createSpace(app, ALICE, "cycle-a");
    const b = await createSpace(app, ALICE, "cycle-b");

    expect((await grant(app, ALICE, a, { spaceUri: b }, "member")).status).toBe(200);
    // Now creating b → a would close the cycle.
    const res = await grant(app, ALICE, b, { spaceUri: a }, "member");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("cycle-detected");
  });

  it("rejects self-reference", async () => {
    const s = await createSpace(app, ALICE, "self-ref");
    const res = await grant(app, ALICE, s, { spaceUri: s }, "member");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("self-reference");
  });

  it("reverse-graph reconcile: adding to source propagates to delegated spaces", async () => {
    const mods = await createSpace(app, ALICE, "mods3");
    const chat1 = await createSpace(app, ALICE, "chat-a");
    const chat2 = await createSpace(app, ALICE, "chat-b");

    // Both chats delegate to mods3.
    expect((await grant(app, ALICE, chat1, { spaceUri: mods }, "member")).status).toBe(200);
    expect((await grant(app, ALICE, chat2, { spaceUri: mods }, "member")).status).toBe(200);

    // Add Charlie to mods3 — should propagate to both chats.
    expect((await grant(app, ALICE, mods, { did: CHARLIE }, "member")).status).toBe(200);

    expect(await flatMembers(app, ALICE, chat1)).toContain(CHARLIE);
    expect(await flatMembers(app, ALICE, chat2)).toContain(CHARLIE);
  });

  it("reverse-graph reconcile: removing from source propagates to delegated spaces", async () => {
    const mods = await createSpace(app, ALICE, "mods4");
    const chat = await createSpace(app, ALICE, "chat-c");

    expect((await grant(app, ALICE, chat, { spaceUri: mods }, "member")).status).toBe(200);
    expect((await grant(app, ALICE, mods, { did: DIANA }, "member")).status).toBe(200);
    expect(await flatMembers(app, ALICE, chat)).toContain(DIANA);

    // Revoke from mods4 — should disappear from chat-c.
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.revoke", ALICE, {
      spaceUri: mods,
      subject: { did: DIANA },
    });
    expect(res.status).toBe(200);

    expect(await flatMembers(app, ALICE, chat)).not.toContain(DIANA);
  });

  it("deleting a delegated-from space re-reconciles parents' spaces_members", async () => {
    const mods = await createSpace(app, ALICE, "cascade-mods");
    const chat = await createSpace(app, ALICE, "cascade-chat");

    // Diana reaches chat only via mods.
    expect((await grant(app, ALICE, mods, { did: DIANA }, "member")).status).toBe(200);
    expect((await grant(app, ALICE, chat, { spaceUri: mods }, "member")).status).toBe(200);
    expect(await flatMembers(app, ALICE, chat)).toContain(DIANA);

    // Delete mods; chat should no longer list Diana as a flattened member.
    const del = await call(app, "POST", "/xrpc/test.comm.community.space.delete", ALICE, {
      spaceUri: mods,
    });
    expect(del.status).toBe(200);

    expect(await flatMembers(app, ALICE, chat)).not.toContain(DIANA);
  });

  it("resync endpoint requires admin+", async () => {
    const s = await createSpace(app, ALICE, "resync-space");
    // Bob is a plain member
    expect((await grant(app, ALICE, s, { did: BOB }, "member")).status).toBe(200);

    const res = await call(app, "POST", "/xrpc/test.comm.community.space.resync", BOB, {
      spaceUri: s,
    });
    expect(res.status).toBe(403);
  });

  it("community.list follows delegation across communities", async () => {
    // Mint a second community. DIANA will have a direct grant only in the
    // second community's space; the second community delegates a group from
    // the first community into one of its own spaces. The actor Alice has no
    // direct grant in the second community but reaches it via the delegation
    // chain, so community.list must surface both.
    const mint = await call(app, "POST", "/xrpc/test.comm.community.mint", DIANA, {});
    expect(mint.status).toBe(200);
    const second = ((await mint.json()) as any).communityDid as string;

    // Diana creates a space in the second community and delegates the first
    // community's (Alice-owned) $admin in as a member.
    const createRes = await call(app, "POST", "/xrpc/test.comm.community.space.create", DIANA, {
      communityDid: second,
      key: "bridged",
    });
    expect(createRes.status).toBe(200);
    const bridged = ((await createRes.json()) as any).space.uri as string;

    const firstAdmin = `at://${COMMUNITY_DID}/tools.atmo.event.space/$admin`;
    expect((await grant(app, DIANA, bridged, { spaceUri: firstAdmin }, "member")).status).toBe(200);

    // Alice has no direct grant in the second community, but is reachable via
    // `bridged` → firstAdmin (where she is owner).
    const res = await call(app, "GET", `/xrpc/test.comm.community.list`, ALICE);
    expect(res.status).toBe(200);
    const dids = ((await res.json()) as any).communities.map((c: any) => c.did);
    expect(dids).toContain(COMMUNITY_DID);
    expect(dids).toContain(second);
  });

  it("resync endpoint works for owner", async () => {
    const s = await createSpace(app, ALICE, "resync-ok");
    const res = await call(app, "POST", "/xrpc/test.comm.community.space.resync", ALICE, {
      spaceUri: s,
    });
    expect(res.status).toBe(200);
  });
});
