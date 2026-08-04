import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePDS, getClient, getPDS } from "../src/index";
import { __resetPdsCachesForTests } from "../src/core/client";
import { type DidDocumentResolver } from "@atcute/identity-resolver";
import { createTestDbWithSchema } from "./helpers";
import type { Did } from "@atcute/lexicons";

describe("validatePdsUrl via resolvePDS — regression baseline", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("accepts a public HTTPS PDS", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:a", handle: "a.bsky.social", pds: "https://shimeji.us-east.host.bsky.network" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:a");
    expect(r?.pds).toBe("https://shimeji.us-east.host.bsky.network");
  });

  it("rejects non-HTTPS PDS (returns pds: null)", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:b", handle: "b.test", pds: "http://malicious.example.com" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:b");
    expect(r?.pds).toBe(null);
  });

  it("rejects 10.x private CIDR", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:c", pds: "https://10.0.0.1" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:c");
    expect(r?.pds).toBe(null);
  });

  it("rejects 192.168.x private CIDR", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:d", pds: "https://192.168.1.1" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:d");
    expect(r?.pds).toBe(null);
  });

  it("rejects 172.16-31.x private CIDR", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:e", pds: "https://172.20.0.5" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:e");
    expect(r?.pds).toBe(null);
  });

  it("rejects localhost and 169.254 link-local", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ did: "did:plc:f", pds: "https://localhost" }), { status: 200 })
    );
    expect((await resolvePDS("did:plc:f"))?.pds).toBe(null);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ did: "did:plc:g", pds: "https://169.254.169.254" }), { status: 200 })
    );
    expect((await resolvePDS("did:plc:g"))?.pds).toBe(null);
  });
});

describe("validatePdsUrl via resolvePDS — additionalAllowedHosts allowlist", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("accepts http://pds.dev.svc.cluster.local when host is on allowlist", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:h", pds: "http://pds.dev.svc.cluster.local" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:h", {
      namespace: "test",
      collections: {},
      networkOverrides: { additionalAllowedHosts: ["pds.dev.svc.cluster.local"] },
    });
    expect(r?.pds).toBe("http://pds.dev.svc.cluster.local");
  });

  it("still rejects http://other.private.host when not on allowlist", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:i", pds: "http://other.private.host" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:i", {
      namespace: "test",
      collections: {},
      networkOverrides: { additionalAllowedHosts: ["pds.dev.svc.cluster.local"] },
    });
    expect(r?.pds).toBe(null);
  });

  it("still rejects http://192.168.1.1 when not on allowlist", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:j", pds: "http://192.168.1.1" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:j", {
      namespace: "test",
      collections: {},
      networkOverrides: { additionalAllowedHosts: ["pds.dev.svc.cluster.local"] },
    });
    expect(r?.pds).toBe(null);
  });

  it("port-agnostic: allowlist matches hostname regardless of port", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:k", pds: "http://pds.dev.svc.cluster.local:8080" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:k", {
      namespace: "test",
      collections: {},
      networkOverrides: { additionalAllowedHosts: ["pds.dev.svc.cluster.local"] },
    });
    expect(r?.pds).toBe("http://pds.dev.svc.cluster.local:8080");
  });

  it("case-insensitive: mixed-case allowlist entries match lowercase URL.hostname", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:l", pds: "http://pds.dev.svc.cluster.local" }), { status: 200 })
    );
    const r = await resolvePDS("did:plc:l", {
      namespace: "test",
      collections: {},
      networkOverrides: { additionalAllowedHosts: ["PDS.Dev.Svc.Cluster.Local"] },
    });
    expect(r?.pds).toBe("http://pds.dev.svc.cluster.local");
  });
});

describe("getPDSViaDidDoc — resolver override", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("falls back to DID doc when slingshot returns no pds, and uses injected resolver", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ did: "did:plc:abc", handle: "alice.test" }), { status: 200 })
    );

    const resolveCalls: string[] = [];
    const injectedResolver: DidDocumentResolver = {
      async resolve(did: string) {
        resolveCalls.push(did);
        return {
          service: [
            { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "http://pds.dev.svc.cluster.local" },
          ],
        } as any;
      },
    } as any;

    const r = await resolvePDS("did:plc:abc", {
      namespace: "test",
      collections: {},
      networkOverrides: {
        resolver: injectedResolver,
        additionalAllowedHosts: ["pds.dev.svc.cluster.local"],
      },
    });
    expect(r?.pds).toBe("http://pds.dev.svc.cluster.local");
    expect(resolveCalls).toContain("did:plc:abc");
  });
});

describe("getClient + getPDS — config plumb-through", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("getClient with config?.networkOverrides.slingshotUrl uses the override", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("my-slingshot")) {
        return new Response(
          JSON.stringify({ did: "did:plc:x", pds: "https://pds.allowed.test" }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const db = await createTestDbWithSchema();
    const client = await getClient("did:plc:x" as Did, db, {
      namespace: "test",
      collections: {},
      networkOverrides: {
        slingshotUrl: "https://my-slingshot.test/xrpc/com.bad-example.identity.resolveMiniDoc",
        additionalAllowedHosts: ["pds.allowed.test"],
      },
    });
    expect(client).toBeDefined();
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("my-slingshot.test"))).toBe(true);
  });

  it("getPDS with no config uses the default slingshot URL (backward-compat)", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("slingshot.microcosm.blue")) {
        return new Response(
          JSON.stringify({ did: "did:plc:y", pds: "https://shimeji.us-east.host.bsky.network" }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const db = await createTestDbWithSchema();
    const pds = await getPDS("did:plc:y" as Did, db);
    expect(pds).toBe("https://shimeji.us-east.host.bsky.network");
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("slingshot.microcosm.blue"))).toBe(true);
  });
});
