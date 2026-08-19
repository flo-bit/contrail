import type {} from "@atcute/atproto";
import { Client } from "@atcute/client";
import { describe, expect, it, vi } from "vitest";
import {
  createPublicServiceClient,
  publicServiceFetchHandler,
} from "../src/public-client";
import type { PublicServiceManifest } from "../src/public-service";

const endpoint = "https://api.example.com";
const serviceDid = "did:web:api.example.com";
const serviceAudience = "did:web:api.example.com#contrail";
const serviceScope =
  "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed";
const method = "com.example.getFeed";
const notifyMethod = "com.example.notifyOfUpdate";
const collection = "community.example.event";
const digest = `sha256:${"a".repeat(64)}`;

function token() {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 60 })}.signature`;
}

function manifest(): PublicServiceManifest {
  return {
    format: "contrail.service",
    version: 2,
    endpoint,
    namespace: "com.example",
    lexicons: { url: `${endpoint}/lexicons/${digest}`, digest },
    status: { url: `${endpoint}/status` },
    collections: [],
    methods: ["com.example.getCursor"],
    serviceAuth: {
      type: "atproto-service-auth",
      serviceDid,
      audience: serviceAudience,
      scope: serviceScope,
      methods: [{ id: method, type: "query" }],
    },
  };
}

function authenticatedClient(jwt: string) {
  const handler = vi.fn(async (pathname: string) => {
    const url = new URL(pathname, "https://pds.example.com");
    expect(url.pathname).toBe("/xrpc/com.atproto.server.getServiceAuth");
    expect(url.searchParams.get("aud")).toBe(serviceAudience);
    expect(url.searchParams.get("lxm")).toBe(method);
    return Response.json({ token: jwt });
  });
  return { client: new Client({ handler }), handler };
}

describe("public service client", () => {
  it("permits insecure endpoints only for explicit loopback development", () => {
    expect(() =>
      createPublicServiceClient({ endpoint: "http://localhost:8787" }),
    ).toThrow("must use HTTPS");
    expect(
      createPublicServiceClient({
        endpoint: "http://127.0.0.1:8787",
        allowInsecureHttp: true,
      }).endpoint,
    ).toBe("http://127.0.0.1:8787");
    expect(() =>
      createPublicServiceClient({
        endpoint: "http://api.example.com",
        allowInsecureHttp: true,
      }),
    ).toThrow("loopback HTTP");
  });

  it("rejects a configured OAuth scope for a different service audience", () => {
    expect(() =>
      createPublicServiceClient({
        endpoint,
        serviceDid,
        serviceAudience,
        scope:
          "rpc?aud=did:web:other.example.com%23contrail&lxm=com.example.getFeed",
        protectedMethods: [method],
      }),
    ).toThrow("different service audience");
  });

  it("accepts semantically equivalent scope parameter ordering", () => {
    const client = createPublicServiceClient({
      endpoint,
      serviceDid,
      serviceAudience,
      scope:
        "rpc?lxm=com.example.getFeed&aud=did:web:api.example.com%23contrail",
      protectedMethods: [method],
    });
    expect(client.scope).toBe(serviceScope);
  });

  it("rejects legacy incomplete or wildcard service-auth configuration", () => {
    expect(() =>
      createPublicServiceClient({ endpoint, serviceDid }),
    ).toThrow("connect --update");
    expect(() =>
      createPublicServiceClient({
        endpoint,
        serviceDid,
        serviceAudience,
        scope: "rpc?aud=did:web:api.example.com%23contrail&lxm=*",
        protectedMethods: [method],
      }),
    ).toThrow("connect --update");
    expect(() =>
      createPublicServiceClient({
        endpoint,
        serviceDid,
        serviceAudience,
        scope: serviceScope,
        protectedMethods: [method, notifyMethod],
      }),
    ).toThrow("exact protected methods");
  });

  it("reads nulls and an empty method list as an anonymous provider", () => {
    // `lex.config.js` is reference material consumers paste from, and an
    // untyped copy spells "no service auth" as nulls rather than absent keys.
    const client = createPublicServiceClient({
      endpoint,
      serviceDid: null,
      serviceAudience: null,
      scope: null,
      protectedMethods: [],
    });
    expect(client.scope).toBeNull();
  });

  it("still rejects a partially configured contract", () => {
    expect(() =>
      createPublicServiceClient({
        endpoint,
        serviceDid,
        serviceAudience,
        scope: serviceScope,
        protectedMethods: [],
      }),
    ).toThrow("incomplete");
  });

  it("keeps anonymous requests anonymous", async () => {
    const fetcher = vi.fn(async () => Response.json({ records: [] }));
    const handler = publicServiceFetchHandler({ endpoint, fetch: fetcher });

    const response = await handler("/xrpc/com.example.listRecords", {
      method: "get",
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not fetch discovery before anonymous requests", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/.well-known/contrail")
        ? Response.json(manifest())
        : Response.json({ records: [] }),
    );
    const handler = publicServiceFetchHandler({ endpoint, fetch: fetcher });

    expect(
      (await handler("/xrpc/com.example.getCursor", { method: "get" })).status,
    ).toBe(200);
    expect(
      (await handler("/xrpc/com.example.getCursor", { method: "get" })).status,
    ).toBe(200);
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).endsWith("/.well-known/contrail"),
      ),
    ).toHaveLength(0);
  });

  it("retries transient discovery failures for protected calls", async () => {
    let discoveries = 0;
    const pds = authenticatedClient(token());
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/.well-known/contrail")) {
        discoveries++;
        return discoveries === 1
          ? new Response(null, { status: 503 })
          : Response.json(manifest());
      }
      return new Response(null, { status: 401 });
    });
    const handler = publicServiceFetchHandler({
      endpoint,
      authenticatedClient: pds.client,
      serviceDid,
      serviceAudience,
      scope: serviceScope,
      protectedMethods: [method],
      fetch: fetcher,
    });

    await expect(handler(`/xrpc/${method}`, { method: "get" })).rejects.toThrow(
      "discovery failed: 503",
    );
    expect((await handler(`/xrpc/${method}`, { method: "get" })).status).toBe(
      401,
    );
    expect(discoveries).toBe(2);
  });

  it("discovers, mints, caches, and attaches method-bound tokens", async () => {
    const jwt = token();
    const pds = authenticatedClient(jwt);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ url, authorization });
      if (url.endsWith("/.well-known/contrail")) {
        return Response.json(manifest());
      }
      return authorization === `Bearer ${jwt}`
        ? Response.json({ records: [] })
        : Response.json(
            { error: "AuthenticationRequired" },
            { status: 401, headers: { "www-authenticate": "Bearer" } },
          );
    });
    const publicClient = createPublicServiceClient({
      endpoint,
      serviceDid,
      serviceAudience,
      scope: serviceScope,
      protectedMethods: [method],
      serviceMethods: [method],
      fetch: fetcher,
    });
    expect(publicClient.endpoint).toBe(endpoint);
    expect(publicClient.scope).toBe(serviceScope);
    const client = publicClient.authenticated(pds.client);
    expect(publicClient.authenticated(pds.client)).toBe(client);

    const first = await (client as any).get(method, {
      params: { actor: "did:plc:test", feed: "network" },
    });
    const second = await (client as any).get(method, {
      params: { actor: "did:plc:test", feed: "network" },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(pds.handler).toHaveBeenCalledTimes(1);
    expect(
      requests.filter((request) =>
        request.url.includes(`/xrpc/${method}`),
      ).map((request) => request.authorization),
    ).toEqual([null, `Bearer ${jwt}`, `Bearer ${jwt}`]);
  });

  it("notifies an open local service without minting service auth", async () => {
    const pdsHandler = vi.fn(async (pathname: string) => {
      const url = new URL(pathname, "https://pds.example.com");
      if (url.pathname === "/xrpc/com.atproto.repo.createRecord") {
        return Response.json({
          uri: `at://did:plc:test/${collection}/3test`,
          cid: "bafyreicid",
        });
      }
      throw new Error(`unexpected PDS call: ${url.pathname}`);
    });
    const notifications: Array<{ authorization: string | null; body: string | null }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      notifications.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return Response.json({ indexed: 1, deleted: 0 });
    });
    const client = createPublicServiceClient({
      endpoint,
      serviceMethods: [],
      collections: [collection],
      notifyMethod,
      fetch: fetcher,
    }).authenticated(new Client({ handler: pdsHandler }));

    expect(client.scope).toBeNull();
    const response = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: "did:plc:test",
        collection,
        record: { $type: collection, name: "Local event" },
      },
    });

    expect(response.ok).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.authorization).toBeNull();
    expect(JSON.parse(notifications[0]!.body!)).toEqual({
      uris: [`at://did:plc:test/${collection}/3test`],
    });
    expect(pdsHandler).toHaveBeenCalledTimes(1);
  });

  it("routes PDS writes and service methods through one authenticated client", async () => {
    const jwt = token();
    const discovered = manifest();
    discovered.serviceAuth = {
      type: "atproto-service-auth",
      serviceDid,
      audience: serviceAudience,
      scope:
        "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed&lxm=com.example.notifyOfUpdate",
      methods: [
        { id: method, type: "query" },
        { id: notifyMethod, type: "procedure" },
      ],
    };
    let pdsWriteShouldFail = false;
    const pdsHandler = vi.fn(async (pathname: string) => {
      const url = new URL(pathname, "https://pds.example.com");
      if (url.pathname === "/xrpc/com.atproto.server.getServiceAuth") {
        return Response.json({ token: jwt });
      }
      if (url.pathname === "/xrpc/com.atproto.identity.resolveHandle") {
        return Response.json({ did: "did:plc:test" });
      }
      if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
        return Response.json({
          uri: `at://did:plc:test/${collection}/3test`,
          cid: "bafyreicid",
          value: { $type: collection, name: "Test event" },
        });
      }
      if (url.pathname === "/xrpc/com.atproto.repo.deleteRecord") {
        return Response.json({});
      }
      if (
        url.pathname === "/xrpc/com.atproto.repo.createRecord" ||
        url.pathname === "/xrpc/com.atproto.repo.putRecord"
      ) {
        if (pdsWriteShouldFail) {
          return Response.json({ error: "InvalidRecord" }, { status: 400 });
        }
        return Response.json({
          uri: `at://did:plc:test/${collection}/3test`,
          cid: "bafyreicid",
        });
      }
      return Response.json({ error: "MethodNotFound" }, { status: 404 });
    });
    const pds = new Client({ handler: pdsHandler });
    const serviceRequests: Array<{ url: string; body: string | null }> = [];
    let notificationShouldFail = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/contrail")) {
        return Response.json(discovered);
      }
      serviceRequests.push({
        url,
        body: typeof init?.body === "string" ? init.body : null,
      });
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== `Bearer ${jwt}`) {
        return Response.json(
          { error: "AuthenticationRequired" },
          { status: 401 },
        );
      }
      return url.endsWith(`/xrpc/${notifyMethod}`)
        ? Response.json({
            indexed: notificationShouldFail ? 0 : 1,
            deleted: 0,
            ...(notificationShouldFail ? { errors: ["retry later"] } : {}),
          })
        : Response.json({ records: [] });
    });
    const notificationError = vi.fn();
    const client = createPublicServiceClient({
      endpoint,
      serviceDid,
      serviceAudience,
      scope:
        "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed&lxm=com.example.notifyOfUpdate",
      protectedMethods: [method, notifyMethod],
      serviceMethods: [method, notifyMethod],
      collections: [collection],
      notifyMethod,
      fetch: fetcher,
    }).authenticated(pds, { onNotificationError: notificationError });

    const write = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: "did:plc:test",
        collection,
        record: { $type: collection, name: "Test event" },
      },
    });
    const feed = await (client as any).get(method, {
      params: { actor: "did:plc:test", feed: "network" },
    });
    const record = await client.get("com.atproto.repo.getRecord", {
      params: {
        repo: "did:plc:test",
        collection,
        rkey: "3test",
      },
    });

    expect(write.ok).toBe(true);
    expect(feed.ok).toBe(true);
    expect(record.ok).toBe(true);
    expect(notificationError).not.toHaveBeenCalled();

    notificationShouldFail = true;
    const updated = await client.post("com.atproto.repo.putRecord", {
      input: {
        repo: "did:plc:test",
        collection,
        rkey: "3test",
        record: { $type: collection, name: "Updated event" },
      },
    });
    expect(updated.ok).toBe(true);
    expect(notificationError).toHaveBeenCalledOnce();

    notificationShouldFail = false;
    const notificationsBeforeDelete = serviceRequests.filter(({ url }) =>
      url.endsWith(`/xrpc/${notifyMethod}`),
    ).length;
    const deleted = await client.post("com.atproto.repo.deleteRecord", {
      input: {
        repo: "did:plc:test",
        collection,
        rkey: "3test",
      },
    });
    expect(deleted.ok).toBe(true);
    expect(
      serviceRequests.filter(({ url }) =>
        url.endsWith(`/xrpc/${notifyMethod}`),
      ).length,
    ).toBe(notificationsBeforeDelete + 1);

    const notificationsBeforeHandleDelete = serviceRequests.filter(({ url }) =>
      url.endsWith(`/xrpc/${notifyMethod}`),
    ).length;
    const deletedByHandle = await client.post("com.atproto.repo.deleteRecord", {
      input: {
        repo: "alice.example.com",
        collection,
        rkey: "3test",
      },
    });
    expect(deletedByHandle.ok).toBe(true);
    expect(
      serviceRequests.filter(({ url }) =>
        url.endsWith(`/xrpc/${notifyMethod}`),
      ).length,
    ).toBe(notificationsBeforeHandleDelete + 1);
    expect(
      serviceRequests.some(
        ({ url, body }) =>
          url.endsWith(`/xrpc/${notifyMethod}`) &&
          body?.includes(`at://did:plc:test/${collection}/3test`),
      ),
    ).toBe(true);

    pdsWriteShouldFail = true;
    const notificationsBeforeFailedWrite = serviceRequests.filter(({ url }) =>
      url.endsWith(`/xrpc/${notifyMethod}`),
    ).length;
    const failed = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: "did:plc:test",
        collection,
        record: { $type: collection, name: "Invalid" },
      },
    });
    expect(failed.ok).toBe(false);
    expect(
      serviceRequests.filter(({ url }) =>
        url.endsWith(`/xrpc/${notifyMethod}`),
      ).length,
    ).toBe(notificationsBeforeFailedWrite);
    pdsWriteShouldFail = false;

    const notificationsBeforeUntrackedWrite = serviceRequests.filter(
      ({ url }) => url.endsWith(`/xrpc/${notifyMethod}`),
    ).length;
    const untracked = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: "did:plc:test",
        collection: "app.bsky.feed.post",
        record: { $type: "app.bsky.feed.post", text: "Not tracked" },
      },
    });
    expect(untracked.ok).toBe(true);
    expect(
      serviceRequests.filter(({ url }) =>
        url.endsWith(`/xrpc/${notifyMethod}`),
      ).length,
    ).toBe(notificationsBeforeUntrackedWrite);
    expect(
      serviceRequests.some(
        ({ url, body }) =>
          url.endsWith(`/xrpc/${notifyMethod}`) &&
          body?.includes(`at://did:plc:test/${collection}/3test`),
      ),
    ).toBe(true);
    expect(
      pdsHandler.mock.calls.some(([pathname]) =>
        String(pathname).includes("com.atproto.repo.createRecord"),
      ),
    ).toBe(true);
  });

  it("refuses a discovered service-auth audience fragment that differs from its lock", async () => {
    const pds = authenticatedClient(token());
    const discovered = manifest();
    discovered.serviceAuth = {
      type: "atproto-service-auth",
      serviceDid,
      audience: "did:web:api.example.com#other",
      scope:
        "rpc?aud=did:web:api.example.com%23other&lxm=com.example.getFeed",
      methods: [{ id: method, type: "query" }],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/.well-known/contrail")
        ? Response.json(discovered)
        : new Response(null, { status: 401 }),
    );
    const client = createPublicServiceClient({
      endpoint,
      authenticatedClient: pds.client,
      serviceDid,
      serviceAudience,
      scope: serviceScope,
      protectedMethods: [method],
      fetch: fetcher,
    });

    await expect((client as any).get(method)).rejects.toThrow(
      "service audience mismatch",
    );
    expect(pds.handler).not.toHaveBeenCalled();
  });

  it("refuses a discovered service DID that differs from its lock", async () => {
    const pds = authenticatedClient(token());
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/.well-known/contrail")
        ? Response.json(manifest())
        : new Response(null, { status: 401 }),
    );
    const client = createPublicServiceClient({
      endpoint,
      authenticatedClient: pds.client,
      serviceDid: "did:web:other.example.com",
      serviceAudience: "did:web:other.example.com#contrail",
      scope:
        "rpc?aud=did:web:other.example.com%23contrail&lxm=com.example.getFeed",
      protectedMethods: [method],
      fetch: fetcher,
    });

    await expect(
      (client as any).get(method),
    ).rejects.toThrow("service DID mismatch");
    expect(pds.handler).not.toHaveBeenCalled();
  });

});
