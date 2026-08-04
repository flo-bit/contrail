import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolvePDS, getClient } from "../src/index";
import { __resetPdsCachesForTests } from "../src/core/client";
import { refreshStaleIdentities } from "../src/index";
import { createTestDbWithSchema } from "./helpers";
import type { ContrailConfig } from "../src/index";
import type { Did } from "@atcute/lexicons";
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from "@atcute/identity-resolver";

type Hit = { method: string; url: string };

interface Stub {
  url: string;
  hits: Hit[];
  setHandler: (h: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
  close: () => Promise<void>;
}

async function startStub(): Promise<Stub> {
  const hits: Hit[] = [];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(404);
    res.end();
  };
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? "?", url: req.url ?? "" });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    setHandler: (h) => {
      handler = h;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let plc: Stub;
let slingshot: Stub;

const baseConfig: ContrailConfig = {
  namespace: "test",
  collections: {},
};

beforeAll(async () => {
  plc = await startStub();
  slingshot = await startStub();
});

afterAll(async () => {
  await plc.close();
  await slingshot.close();
});

beforeEach(() => {
  plc.hits.length = 0;
  slingshot.hits.length = 0;
  __resetPdsCachesForTests();
});

describe("networkOverrides — full chain integration", () => {
  it("resolvePDS routes slingshot fetch to slingshotUrl override", async () => {
    slingshot.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ did: "did:plc:abc", handle: "alice.test", pds: "http://pds.private.test" }));
    });

    const config: ContrailConfig = {
      ...baseConfig,
      networkOverrides: {
        slingshotUrl: `${slingshot.url}/xrpc/com.bad-example.identity.resolveMiniDoc`,
        additionalAllowedHosts: ["pds.private.test"],
      },
    };
    const result = await resolvePDS("did:plc:abc", config);
    expect(result?.pds).toBe("http://pds.private.test");
    expect(slingshot.hits.length).toBeGreaterThan(0);
    expect(slingshot.hits[0].url).toContain("identifier=did%3Aplc%3Aabc");
  });

  it("rejects pds when not in allowlist (default validator still applies)", async () => {
    slingshot.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ did: "did:plc:bcd", pds: "http://pds.private.test" }));
    });

    const config: ContrailConfig = {
      ...baseConfig,
      networkOverrides: {
        slingshotUrl: `${slingshot.url}/xrpc/com.bad-example.identity.resolveMiniDoc`,
      },
    };
    const result = await resolvePDS("did:plc:bcd", config);
    expect(result?.pds).toBe(null);
  });

  it("falls back to plcUrl when slingshot returns no pds", async () => {
    slingshot.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ did: "did:plc:cde", handle: "carol.test" }));
    });
    plc.setHandler((req, res) => {
      const decoded = req.url ? decodeURIComponent(req.url) : "";
      if (decoded.includes("did:plc:cde")) {
        res.writeHead(200, { "content-type": "application/did+ld+json" });
        res.end(JSON.stringify({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: "did:plc:cde",
          alsoKnownAs: ["at://carol.test"],
          verificationMethod: [],
          service: [
            { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "http://pds.private.test" },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const resolver = new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver({ apiUrl: plc.url }),
        web: new WebDidDocumentResolver(),
      },
    });
    const config: ContrailConfig = {
      ...baseConfig,
      networkOverrides: {
        slingshotUrl: `${slingshot.url}/xrpc/com.bad-example.identity.resolveMiniDoc`,
        resolver,
        additionalAllowedHosts: ["pds.private.test"],
      },
    };
    const result = await resolvePDS("did:plc:cde", config);
    expect(result?.pds).toBe("http://pds.private.test");
    expect(plc.hits.length).toBeGreaterThan(0);
  });

  it("refreshStaleIdentities persists pds via override path", async () => {
    slingshot.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ did: "did:plc:def", handle: "dave.test", pds: "http://pds.private.test" }));
    });
    const config: ContrailConfig = {
      ...baseConfig,
      networkOverrides: {
        slingshotUrl: `${slingshot.url}/xrpc/com.bad-example.identity.resolveMiniDoc`,
        additionalAllowedHosts: ["pds.private.test"],
      },
    };
    const db = await createTestDbWithSchema();
    await refreshStaleIdentities(db, ["did:plc:def"], config);

    const row = await db
      .prepare("SELECT did, pds FROM identities WHERE did = ?")
      .bind("did:plc:def")
      .first<{ did: string; pds: string }>();
    expect(row?.pds).toBe("http://pds.private.test");
    expect(slingshot.hits.length).toBeGreaterThan(0);
  });

  it("getClient with override config resolves PDS via stubbed slingshot", async () => {
    slingshot.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ did: "did:plc:efg", handle: "eve.test", pds: "http://pds.private.test" }));
    });
    const config: ContrailConfig = {
      ...baseConfig,
      networkOverrides: {
        slingshotUrl: `${slingshot.url}/xrpc/com.bad-example.identity.resolveMiniDoc`,
        additionalAllowedHosts: ["pds.private.test"],
      },
    };
    const db = await createTestDbWithSchema();
    const client = await getClient("did:plc:efg" as Did, db, config);
    expect(client).toBeDefined();
    expect(slingshot.hits.some((h) => h.url.includes("identifier=did%3Aplc%3Aefg"))).toBe(true);
  });
});
