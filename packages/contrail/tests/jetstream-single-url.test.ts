import { describe, it, expect, vi, beforeEach } from "vitest";

// Records what `url` shape ingestEvents hands to @atcute's JetstreamSubscription.
// @atcute treats a string url and an array url differently: for an ARRAY it seeds
// `#lastUsedUrl = ''`, so the very first connect satisfies its "switched instance"
// check and rolls the cursor back 10s — even when the array holds a single URL and
// nothing switched. Passing a string seeds `#lastUsedUrl = undefined`, so no
// spurious rollback (and thus no re-delivered events / DUPLICATE-in-cycle flood).
const recorder = vi.hoisted(() => ({ url: undefined as unknown }));

vi.mock("@atcute/jetstream", () => {
  class MockJetstreamSubscription {
    cursor: number | null = null;
    constructor(opts: { url?: unknown; cursor?: number }) {
      recorder.url = opts?.url;
      this.cursor = typeof opts?.cursor === "number" ? opts.cursor : null;
    }
    async *[Symbol.asyncIterator]() {
      // Quiet stream: block so ingestEvents exits via its safety timeout.
      await new Promise(() => {});
    }
  }
  return { JetstreamSubscription: MockJetstreamSubscription };
});

import { ingestEvents } from "../src/core/jetstream";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";

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

describe("ingestEvents — jetstream url shape (om-6zdo)", () => {
  beforeEach(() => {
    recorder.url = undefined;
  });

  it("passes a single configured jetstream as a string (avoids @atcute's array-only cursor rollback)", async () => {
    await ingestEvents(
      configWithJetstreams(["wss://jetstream.example/subscribe"]),
      999_999,
      50,
    );
    expect(recorder.url).toBe("wss://jetstream.example/subscribe");
  });

  it("passes multiple configured jetstreams as an array (preserves failover + intentional switch rollback)", async () => {
    await ingestEvents(
      configWithJetstreams(["wss://a.example", "wss://b.example"]),
      999_999,
      50,
    );
    expect(recorder.url).toEqual(["wss://a.example", "wss://b.example"]);
  });
});
