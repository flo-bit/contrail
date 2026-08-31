import { beforeEach, describe, expect, it, vi } from "vitest";

const recorder = vi.hoisted(() => ({ url: undefined as unknown }));

vi.mock("../src/core/jetstream-live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/jetstream-live")>();
  class MockJetstreamSubscription {
    cursor: number | null;
    constructor(opts: { url?: unknown; cursor?: number }) {
      recorder.url = opts.url;
      this.cursor = opts.cursor ?? 0;
    }
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    }
  }
  return { ...actual, JetstreamLiveSubscription: MockJetstreamSubscription };
});

import { ingestEvents, resolveConfig, type ContrailConfig } from "../src/index";

const silentLogger = { log() {}, warn() {}, error() {} };

function configWithJetstreams(jetstreams: string[]): ContrailConfig {
  return {
    ...resolveConfig({
      namespace: "com.example",
      jetstreams,
      collections: {
        event: { collection: "community.lexicon.calendar.event" },
      },
    }),
    logger: silentLogger,
  };
}

describe("Jetstream v2 service pinning", () => {
  beforeEach(() => {
    recorder.url = undefined;
  });

  it("passes the one configured service to the v2 live adapter", async () => {
    await ingestEvents(
      configWithJetstreams(["https://jetstream.example"]),
      999_999,
      25,
    );
    expect(recorder.url).toBe("https://jetstream.example");
  });

  it("rejects a service pool because v2 seq cursors are instance-local", async () => {
    await expect(
      ingestEvents(
        configWithJetstreams(["https://a.example", "https://b.example"]),
        999_999,
        25,
      ),
    ).rejects.toThrow("exactly one pinned service");
  });
});
