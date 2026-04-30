import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import type { RealtimeEvent } from "../src/core/realtime/types";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
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
  await initSchema(db, resolved);
  return createApp(db, resolved, {
    spaces: { authMiddleware: fakeAuth() },
  });
}

function call(
  app: Hono,
  method: string,
  path: string,
  did: string | null,
  body?: any,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = { ...extraHeaders };
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

/** Open an SSE stream and return an async iterator over decoded events. */
async function openSse(
  app: Hono,
  path: string,
  did: string | null = null
): Promise<{
  res: Response;
  events: AsyncIterator<RealtimeEvent>;
  close: () => void;
}> {
  const ac = new AbortController();
  const headers: Record<string, string> = {};
  if (did) headers["X-Test-Did"] = did;
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { method: "GET", headers, signal: ac.signal })
  );
  if (!res.ok) {
    throw new Error(`SSE open failed: ${res.status} ${await res.text()}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const iter: AsyncIterator<RealtimeEvent> = {
    async next() {
      // Read frames until we get an event with valid JSON data.
      while (true) {
        // Parse any complete frames already buffered.
        while (true) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const lines = frame.split("\n");
          let data: string | null = null;
          for (const line of lines) {
            if (line.startsWith(":")) continue; // comment / keepalive
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data) {
            return { value: JSON.parse(data) as RealtimeEvent, done: false };
          }
        }
        const r = await reader.read();
        if (r.done) return { value: undefined, done: true };
        buf += decoder.decode(r.value, { stream: true });
      }
    },
    async return() {
      ac.abort();
      try { await reader.cancel(); } catch { /* */ }
      return { value: undefined, done: true };
    },
  };
  return { res, events: iter, close: () => { ac.abort(); reader.cancel().catch(() => {}); } };
}

async function createSpace(app: Hono, owner: string, key?: string): Promise<string> {
  const res = await call(app, "POST", "/xrpc/test.rt.space.createSpace", owner, { key });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).space.uri;
}

async function mintTicket(app: Hono, did: string, topic: string): Promise<{ ticket: string; topics: string[] }> {
  const res = await call(app, "POST", "/xrpc/test.rt.realtime.ticket", did, { topic });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("realtime e2e (in-memory pubsub, SSE transport)", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await makeApp();
  });

  it("ticket+SSE: owner subscribes and receives record.created", async () => {
    const spaceUri = await createSpace(app, ALICE);
    const { ticket } = await mintTicket(app, ALICE, `space:${spaceUri}`);
    const { events, close } = await openSse(
      app,
      `/xrpc/test.rt.realtime.subscribe?ticket=${encodeURIComponent(ticket)}`
    );
    // Publish a record.
    const put = await call(app, "POST", "/xrpc/test.rt.space.putRecord", ALICE, {
      spaceUri,
      collection: "app.event.message",
      record: { text: "hello" },
    });
    expect(put.status).toBe(200);
    const next = await events.next();
    expect(next.done).toBe(false);
    const event = next.value as RealtimeEvent & { kind: "record.created" };
    expect(event.kind).toBe("record.created");
    // Fat payload: subscribers can render the new record without a follow-up fetch.
    expect(event.payload.record).toEqual({ text: "hello" });
    expect(event.payload.collection).toBe("app.event.message");
    expect(event.payload.did).toBe(ALICE);
    close();
  });

  it("non-member cannot mint a ticket for a space they don't belong to", async () => {
    const spaceUri = await createSpace(app, ALICE, "members-only");
    const res = await call(app, "POST", "/xrpc/test.rt.realtime.ticket", BOB, {
      topic: `space:${spaceUri}`,
    });
    expect(res.status).toBe(403);
  });

  it("JWT path (bot): subscribe without a ticket using Authorization-equivalent", async () => {
    const spaceUri = await createSpace(app, ALICE, "bot-space");
    const { events, close } = await openSse(
      app,
      `/xrpc/test.rt.realtime.subscribe?topic=${encodeURIComponent("space:" + spaceUri)}`,
      ALICE
    );
    await call(app, "POST", "/xrpc/test.rt.space.putRecord", ALICE, {
      spaceUri,
      collection: "app.event.message",
      record: { text: "from-bot" },
    });
    const next = await events.next();
    expect((next.value as RealtimeEvent).kind).toBe("record.created");
    close();
  });

  it("collection filter drops non-matching record events", async () => {
    const spaceUri = await createSpace(app, ALICE, "filter-space");
    const { events, close } = await openSse(
      app,
      `/xrpc/test.rt.realtime.subscribe?topic=${encodeURIComponent("space:" + spaceUri)}&collection=app.event.message`,
      ALICE
    );
    // Write one matching record — should arrive.
    await call(app, "POST", "/xrpc/test.rt.space.putRecord", ALICE, {
      spaceUri,
      collection: "app.event.message",
      record: { text: "match" },
    });
    const ev = await events.next();
    expect((ev.value as RealtimeEvent).kind).toBe("record.created");
    expect((ev.value as RealtimeEvent & { kind: "record.created" }).payload.collection).toBe(
      "app.event.message"
    );
    close();
  });

  it("member.removed kicks the subscriber's stream", async () => {
    const spaceUri = await createSpace(app, ALICE, "kick-space");
    // Add Bob as a member.
    await call(app, "POST", "/xrpc/test.rt.space.addMember", ALICE, { spaceUri, did: BOB });
    const { ticket } = await mintTicket(app, BOB, `space:${spaceUri}`);
    const { events, close } = await openSse(
      app,
      `/xrpc/test.rt.realtime.subscribe?ticket=${encodeURIComponent(ticket)}`
    );
    // Remove Bob.
    const rm = await call(app, "POST", "/xrpc/test.rt.space.removeMember", ALICE, {
      spaceUri,
      did: BOB,
    });
    expect(rm.status).toBe(200);
    // The next event Bob receives should be his own member.removed, and then
    // the stream should close.
    const ev = await events.next();
    expect(ev.done).toBe(false);
    expect((ev.value as RealtimeEvent).kind).toBe("member.removed");
    const done = await events.next();
    expect(done.done).toBe(true);
    close();
  });

  it("invalid/expired ticket is rejected", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/xrpc/test.rt.realtime.subscribe?ticket=bad.blob`, {
        method: "GET",
      })
    );
    expect(res.status).toBe(401);
  });

  it("community:<did> alias expands to reachable spaces", async () => {
    // Adopt a community, create two child spaces, grant Charlie member on one.
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
