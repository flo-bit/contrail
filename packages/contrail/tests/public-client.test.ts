import type {} from "@atcute/atproto";
import { Client } from "@atcute/client";
import { describe, expect, it, vi } from "vitest";
import {
  createPublicServiceClient,
  publicServiceFetchHandler,
} from "../src/public-client";
import type { PublicServiceManifest } from "../src/public-service";

const endpoint = "https://api.example.com";
const method = "com.example.getFeed";
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
    version: 1,
    endpoint,
    namespace: "com.example",
    contract: { digest },
    lexicons: { url: `${endpoint}/lexicons/${digest}`, digest },
    status: { url: `${endpoint}/status` },
    collections: [],
    methods: ["com.example.getCursor"],
    serviceAuth: {
      type: "atproto-service-auth",
      audience: "did:web:api.example.com",
      methods: [{ id: method, type: "query" }],
    },
  };
}

function authenticatedPds(jwt: string) {
  const handler = vi.fn(async (pathname: string) => {
    const url = new URL(pathname, "https://pds.example.com");
    expect(url.pathname).toBe("/xrpc/com.atproto.server.getServiceAuth");
    expect(url.searchParams.get("aud")).toBe("did:web:api.example.com");
    expect(url.searchParams.get("lxm")).toBe(method);
    return Response.json({ token: jwt });
  });
  return { client: new Client({ handler }), handler };
}

describe("public service client", () => {
  it("keeps anonymous requests anonymous", async () => {
    const fetcher = vi.fn(async () => Response.json({ records: [] }));
    const handler = publicServiceFetchHandler({ endpoint, fetch: fetcher });

    const response = await handler("/xrpc/com.example.listRecords", {
      method: "get",
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("discovers, mints, caches, and attaches method-bound tokens", async () => {
    const jwt = token();
    const pds = authenticatedPds(jwt);
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
    const client = createPublicServiceClient({
      endpoint,
      authenticatedPds: pds.client,
      contractDigest: digest,
      fetch: fetcher,
    });

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

  it("refuses runtime discovery that differs from an optional lock pin", async () => {
    const pds = authenticatedPds(token());
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/.well-known/contrail")
        ? Response.json(manifest())
        : new Response(null, { status: 401 }),
    );
    const handler = publicServiceFetchHandler({
      endpoint,
      authenticatedPds: pds.client,
      contractDigest: `sha256:${"b".repeat(64)}`,
      fetch: fetcher,
    });

    await expect(
      handler(`/xrpc/${method}`, { method: "get" }),
    ).rejects.toThrow("contract digest mismatch");
    expect(pds.handler).not.toHaveBeenCalled();
  });
});
