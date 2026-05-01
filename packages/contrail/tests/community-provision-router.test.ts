import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";

const ALICE = "did:plc:alice";
const MASTER_KEY = new Uint8Array(32).fill(99);
const PDS_ENDPOINT = "https://pds.test";
const PLC_DIRECTORY = "https://plc.test";

/** Captures upstream calls so we can assert the right RPCs ran. */
const upstreamCalls: Array<{ url: string; method: string; body: any }> = [];

// Placeholder JWT — the orchestrator passes accessJwt through to PDS calls
// untouched; nothing in the contrail flow parses its claims.
const FAKE_ACCESS_JWT = "head.body.sig";

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body as string) : {};
  upstreamCalls.push({ url, method, body });

  // PLC submit: POST {plcDirectory}/{did} (genesis + update share the URL).
  if (url.startsWith(`${PLC_DIRECTORY}/`) && url.endsWith("/log/last") === false && method === "POST") {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  // PLC log/last: not used in the happy path but be defensive.
  if (url.endsWith("/log/last") && method === "GET") {
    return new Response(JSON.stringify({ cid: "bafyreitestcid" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  // PDS createAccount.
  if (url === `${PDS_ENDPOINT}/xrpc/com.atproto.server.createAccount` && method === "POST") {
    return new Response(
      JSON.stringify({
        did: body.did,
        handle: body.handle,
        accessJwt: FAKE_ACCESS_JWT,
        refreshJwt: "RT",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  // PDS getRecommendedDidCredentials.
  if (
    url === `${PDS_ENDPOINT}/xrpc/com.atproto.identity.getRecommendedDidCredentials`
  ) {
    return new Response(
      JSON.stringify({
        rotationKeys: [],
        verificationMethods: { atproto: "did:key:zPdsSig" },
        alsoKnownAs: ["at://newcomm.pds.test"],
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: PDS_ENDPOINT,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  // PDS activateAccount.
  if (url === `${PDS_ENDPOINT}/xrpc/com.atproto.server.activateAccount` && method === "POST") {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }

  return new Response(`unmocked: ${method} ${url}`, { status: 404 });
}

const CONFIG: ContrailConfig = {
  namespace: "test.comm",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:test.example#svc",
  },
  community: {
    masterKey: MASTER_KEY,
    plcDirectory: PLC_DIRECTORY,
    fetch: mockFetch,
  },
};

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

async function call(
  app: Hono,
  method: string,
  path: string,
  did: string | null,
  body?: any
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (did !== null) headers["X-Test-Did"] = did;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

describe("POST /xrpc/{ns}.community.provision", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await makeApp();
  });

  it("requires auth", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.provision", null, {
      handle: "x.pds.test",
      email: "x@x.test",
      password: "p",
      pdsEndpoint: PDS_ENDPOINT,
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing required fields", async () => {
    const res = await call(app, "POST", "/xrpc/test.comm.community.provision", ALICE, {});
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("InvalidRequest");
  });

  it("provisions a community and returns did + status=activated", async () => {
    const before = upstreamCalls.length;
    const res = await call(app, "POST", "/xrpc/test.comm.community.provision", ALICE, {
      handle: "newcomm.pds.test",
      email: "newcomm@x.test",
      password: "secret",
      inviteCode: "code-x",
      pdsEndpoint: PDS_ENDPOINT,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { communityDid: string; status: string };

    expect(body.communityDid).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(body.status).toBe("activated");

    // Verify the row was inserted into communities with mode='provision'.
    // We round-trip via the GET list endpoint so we don't have to reach into
    // the adapter — the route bootstrapped reserved spaces with the caller as
    // owner, which makes the community reachable.
    const listRes = await call(app, "GET", "/xrpc/test.comm.community.list", ALICE);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      communities: Array<{ did: string; mode: string }>;
    };
    const row = list.communities.find((r) => r.did === body.communityDid);
    expect(row).toBeDefined();
    expect(row!.mode).toBe("provision");

    // Confirm we touched all five upstream RPCs: 2 PLC posts (genesis + update),
    // createAccount, getRecommendedDidCredentials, activateAccount.
    const ourCalls = upstreamCalls.slice(before);
    const plcPosts = ourCalls.filter(
      (c) => c.url.startsWith(`${PLC_DIRECTORY}/`) && c.method === "POST"
    );
    expect(plcPosts.length).toBe(2);
    expect(
      ourCalls.some((c) =>
        c.url.endsWith("/xrpc/com.atproto.server.createAccount")
      )
    ).toBe(true);
    expect(
      ourCalls.some((c) =>
        c.url.endsWith("/xrpc/com.atproto.identity.getRecommendedDidCredentials")
      )
    ).toBe(true);
    expect(
      ourCalls.some((c) =>
        c.url.endsWith("/xrpc/com.atproto.server.activateAccount")
      )
    ).toBe(true);
  });
});
