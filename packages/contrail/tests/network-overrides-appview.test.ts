import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/core/router";
import { runIngestCycle } from "../src/core/jetstream";
import { __resetPdsCachesForTests } from "../src/core/client";
import { createTestDbWithSchema, TEST_CONFIG } from "./helpers";
import type { ContrailConfig } from "../src/core/types";

// Mock the Jetstream subscription so `runIngestCycle` ingests one synthetic
// commit without opening a real WebSocket. Everything else in the appview
// ingest path runs for real, so this exercises the live-ingest refresh path
// end-to-end (the smoking-gun call site `refreshStaleIdentities(db, dids)`).
vi.mock("@atcute/jetstream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atcute/jetstream")>();
  class MockJetstreamSubscription {
    cursor: number | null = null;
    constructor(_opts: unknown) {}
    async *[Symbol.asyncIterator]() {
      yield {
        kind: "commit",
        // A past time_us so the ingest loop doesn't treat it as "caught up".
        time_us: 1_000_000,
        did: "did:plc:ingest",
        commit: {
          collection: "community.lexicon.calendar.event",
          operation: "create",
          rkey: "abc",
          cid: "bafyabc",
          record: { name: "Test Event", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
        },
      };
    }
  }
  return { ...actual, JetstreamSubscription: MockJetstreamSubscription };
});

const silentLogger = { log() {}, warn() {}, error() {} };

const OVERRIDE = {
  slingshotUrl: "https://my-slingshot.test/xrpc/com.bad-example.identity.resolveMiniDoc",
  additionalAllowedHosts: ["pds.allowed.test"],
};

function overrideConfig(): ContrailConfig {
  return { ...TEST_CONFIG, logger: silentLogger, networkOverrides: OVERRIDE };
}

describe("networkOverrides — appview entry points thread config", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ did: "did:plc:resolved", handle: "user.test", pds: "https://pds.allowed.test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // router actor-resolution path: GET /xrpc/<ns>.getProfile -> resolveActor
  it("router getProfile resolves a handle via the override slingshot", async () => {
    const db = await createTestDbWithSchema();
    const app = createApp(db, overrideConfig());

    await app.fetch(
      new Request(`http://localhost/xrpc/${TEST_CONFIG.namespace}.getProfile?actor=user.test`),
    );

    // The handle lookup (identifier=user.test) must go to the override
    // slingshot, not the default public one. Before the fix `resolveActor`
    // was called without `config`, so this fetch hit the default URL.
    const hitOverrideForHandle = fetchSpy.mock.calls.some(([u]) => {
      const s = String(u);
      return s.includes("my-slingshot.test") && s.includes("identifier=user.test");
    });
    expect(hitOverrideForHandle).toBe(true);
  });

  // live-ingest refresh path: runIngestCycle -> refreshStaleIdentities
  it("jetstream ingest cycle refreshes identities via the override slingshot", async () => {
    const db = await createTestDbWithSchema();

    await runIngestCycle(db, overrideConfig(), 1_000);

    // refreshStaleIdentities resolved the ingested DID; before the fix it was
    // called without `config`, so the resolve hit the default slingshot.
    const hitOverride = fetchSpy.mock.calls.some(([u]) =>
      String(u).includes("my-slingshot.test"),
    );
    expect(hitOverride).toBe(true);
  });
});
