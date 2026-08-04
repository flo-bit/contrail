import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveIdentity,
  resolveIdentities,
  resolveActor,
  refreshStaleIdentities,
} from "../src/index";
import { __resetPdsCachesForTests } from "../src/index";
import { createTestDbWithSchema } from "./helpers";
import type { Did } from "@atcute/lexicons";

describe("identity.ts — config plumb-through", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const overrideConfig = {
    namespace: "test",
    collections: {},
    networkOverrides: {
      slingshotUrl: "https://my-slingshot.test/xrpc/com.bad-example.identity.resolveMiniDoc",
      additionalAllowedHosts: ["pds.allowed.test"],
    },
  };

  it("resolveIdentity routes slingshot to override URL", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:a", handle: "a.test", pds: "https://pds.allowed.test" }), { status: 200 }),
    );
    const db = await createTestDbWithSchema();
    const id = await resolveIdentity(db, "did:plc:a" as Did, overrideConfig);
    expect(id.pds).toBe("https://pds.allowed.test");
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("my-slingshot.test"))).toBe(true);
  });

  it("resolveIdentities batch routes to override URL", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      const id = new URL(url).searchParams.get("identifier") ?? "did:plc:?";
      return new Response(
        JSON.stringify({ did: id, handle: `${id}.test`, pds: "https://pds.allowed.test" }),
        { status: 200 },
      );
    });
    const db = await createTestDbWithSchema();
    const m = await resolveIdentities(db, ["did:plc:b", "did:plc:c"], overrideConfig);
    expect(m.get("did:plc:b")?.pds).toBe("https://pds.allowed.test");
    expect(m.get("did:plc:c")?.pds).toBe("https://pds.allowed.test");
  });

  it("resolveActor routes a handle lookup to override URL", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:d", handle: "user.test", pds: "https://pds.allowed.test" }), { status: 200 }),
    );
    const db = await createTestDbWithSchema();
    const did = await resolveActor(db, "user.test", overrideConfig);
    expect(did).toBe("did:plc:d");
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("my-slingshot.test"))).toBe(true);
  });

  it("refreshStaleIdentities routes to override URL", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:e", handle: "e.test", pds: "https://pds.allowed.test" }), { status: 200 }),
    );
    const db = await createTestDbWithSchema();
    await refreshStaleIdentities(db, ["did:plc:e"], overrideConfig);
    const row = await db.prepare("SELECT did, pds FROM identities WHERE did = ?").bind("did:plc:e").first<{ pds: string }>();
    expect(row?.pds).toBe("https://pds.allowed.test");
  });

  it("backward-compat: no config preserves default slingshot URL", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ did: "did:plc:f", handle: "f.bsky.social", pds: "https://shimeji.us-east.host.bsky.network" }), { status: 200 }),
    );
    const db = await createTestDbWithSchema();
    const id = await resolveIdentity(db, "did:plc:f" as Did);
    expect(id.pds).toBe("https://shimeji.us-east.host.bsky.network");
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("slingshot.microcosm.blue"))).toBe(true);
  });
});
