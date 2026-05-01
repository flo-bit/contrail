import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";

const ALICE = "did:plc:alice";
const MASTER_KEY = new Uint8Array(32).fill(99);
const ALLOWED_PDS = "https://allowed.pds.test";
const ATTACKER_PDS = "https://attacker.pds.test";
const PLC_DIRECTORY = "https://plc.test";

const FAKE_ACCESS_JWT = "head.body.sig";

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body as string) : {};

  if (url === `${ALLOWED_PDS}/xrpc/com.atproto.server.describeServer`) {
    return new Response(JSON.stringify({ did: "did:web:allowed.pds.test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith(`${PLC_DIRECTORY}/`) && !url.endsWith("/log/last") && method === "POST") {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/log/last") && method === "GET") {
    return new Response(JSON.stringify({ cid: "bafyreitestcid" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === `${ALLOWED_PDS}/xrpc/com.atproto.server.createAccount` && method === "POST") {
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
  if (url === `${ALLOWED_PDS}/xrpc/com.atproto.identity.getRecommendedDidCredentials`) {
    return new Response(
      JSON.stringify({
        rotationKeys: [],
        verificationMethods: { atproto: "did:key:zPdsSig" },
        alsoKnownAs: ["at://newcomm.allowed.pds.test"],
        services: {
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: ALLOWED_PDS },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url === `${ALLOWED_PDS}/xrpc/com.atproto.server.activateAccount` && method === "POST") {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === `${ALLOWED_PDS}/xrpc/com.atproto.server.createAppPassword` && method === "POST") {
    return new Response(
      JSON.stringify({ name: body.name, password: "minted-app-pw" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(`unmocked: ${method} ${url}`, { status: 404 });
}

function buildConfig(allowedPdsEndpoints: string[] | undefined): ContrailConfig {
  return {
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
      allowedPdsEndpoints,
    },
  };
}

function fakeAuth(): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", { issuer: did, audience: "did:web:test.example#svc", lxm: undefined });
    await next();
  };
}

async function makeApp(allowedPdsEndpoints: string[] | undefined): Promise<Hono> {
  const db = createSqliteDatabase(":memory:");
  const cfg = buildConfig(allowedPdsEndpoints);
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);
  return createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
}

async function call(app: Hono, body: any): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost/xrpc/test.comm.community.provision`, {
      method: "POST",
      headers: { "X-Test-Did": ALICE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("provision pdsEndpoint allowlist (M3)", () => {
  it("rejects pdsEndpoint not in allowedPdsEndpoints", async () => {
    const app = await makeApp([ALLOWED_PDS]);
    const res = await call(app, {
      handle: "newcomm.attacker.pds.test",
      email: "x@x.test",
      password: "secret",
      pdsEndpoint: ATTACKER_PDS,
      rotationKey: "did:key:zStubCallerRotationKey",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string; message: string };
    expect(j.error).toBe("InvalidRequest");
    expect(j.message).toMatch(/pdsEndpoint/i);
  });

  it("accepts pdsEndpoint that is in allowedPdsEndpoints", async () => {
    const app = await makeApp([ALLOWED_PDS]);
    const res = await call(app, {
      handle: "newcomm.allowed.pds.test",
      email: "x@x.test",
      password: "secret",
      inviteCode: "code-x",
      pdsEndpoint: ALLOWED_PDS,
      rotationKey: "did:key:zStubCallerRotationKey",
    });
    expect(res.status).toBe(200);
  });

  it("when allowedPdsEndpoints is undefined, accepts any pdsEndpoint (back-compat)", async () => {
    const app = await makeApp(undefined);
    const res = await call(app, {
      handle: "newcomm.allowed.pds.test",
      email: "x@x.test",
      password: "secret",
      inviteCode: "code-x",
      pdsEndpoint: ALLOWED_PDS,
      rotationKey: "did:key:zStubCallerRotationKey",
    });
    expect(res.status).toBe(200);
  });

  it("when allowedPdsEndpoints is empty array, accepts any pdsEndpoint (back-compat)", async () => {
    const app = await makeApp([]);
    const res = await call(app, {
      handle: "newcomm.allowed.pds.test",
      email: "x@x.test",
      password: "secret",
      inviteCode: "code-x",
      pdsEndpoint: ALLOWED_PDS,
      rotationKey: "did:key:zStubCallerRotationKey",
    });
    expect(res.status).toBe(200);
  });
});
