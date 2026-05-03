/** Realtime + community integration test. Lives here (not in contrail) so
 *  contrail's package.json doesn't have to dev-depend on contrail-community
 *  (which would create a build-graph cycle in turbo).
 *
 *  Tests that `community:<did>` topics expand to the caller's reachable
 *  community spaces — the cross-cutting concern that needs both modules. */

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import {
  createApp,
  initSchema,
  resolveConfig,
  type ContrailConfig,
} from "@atmo-dev/contrail";
import { createCommunityIntegration } from "../src/integration";

const ALICE = "did:plc:alice";
const CHARLIE = "did:plc:charlie";

const MASTER_KEY = new Uint8Array(32).fill(5);
const REALTIME_SECRET = new Uint8Array(32).fill(9);

const CONFIG: ContrailConfig = {
  namespace: "test.rt",
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
    resolver: mockResolver(),
  },
  realtime: {
    ticketSecret: REALTIME_SECRET,
    keepaliveMs: 60_000,
  },
};

function mockResolver(): any {
  return {
    resolve: async (_did: string) => ({
      id: _did,
      service: [
        { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.test" },
      ],
    }),
  };
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/xrpc/com.atproto.server.createSession")) {
    return new Response(
      JSON.stringify({ accessJwt: "a.b.c", refreshJwt: "r.r.r", did: "did:plc:community" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url.startsWith("https://plc.test/")) return new Response("{}", { status: 200 });
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

describe("realtime + community", () => {
  let app: Hono;
  beforeAll(async () => {
    app = await makeApp();
  });

  it("community:<did> alias expands to reachable spaces", async () => {
    // Adopt a community, create a child space, grant Charlie member.
    const adoptRes = await call(app, "POST", "/xrpc/test.rt.community.adopt", ALICE, {
      identifier: "did:plc:community",
      appPassword: "anything", // mockFetch returns 200 for createSession
    });
    expect(adoptRes.status).toBe(200);
    const { communityDid } = (await adoptRes.json()) as any;

    const c1 = await call(app, "POST", "/xrpc/test.rt.community.space.create", ALICE, {
      communityDid,
      key: "general",
    });
    expect(c1.status).toBe(200);
    const general = ((await c1.json()) as any).space.uri as string;

    // Grant Charlie as member in general.
    const g = await call(app, "POST", "/xrpc/test.rt.community.space.grant", ALICE, {
      spaceUri: general,
      subject: { did: CHARLIE },
      accessLevel: "member",
    });
    expect(g.status).toBe(200);

    // Charlie mints a community-alias ticket; should expand to [space:general].
    const ticketRes = await call(app, "POST", "/xrpc/test.rt.realtime.ticket", CHARLIE, {
      topic: `community:${communityDid}`,
    });
    expect(ticketRes.status).toBe(200);
    const body = (await ticketRes.json()) as any;
    expect(body.topics).toContain(`space:${general}`);
  });
});
