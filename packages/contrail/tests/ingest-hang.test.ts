import { describe, it, expect, vi, beforeEach } from "vitest";

// Controller the mocked Jetstream reads from. `script` is an async-generator
// factory each test sets; `abort` lets a test stop a still-running flood once
// its assertions are done (so the buggy path can't leak timers post-failure).
const jetstream = vi.hoisted(() => ({
  script: null as
    | null
    | ((self: { cursor: number | null }) => AsyncGenerator<unknown>),
  abort: false,
}));

// Replace the real WebSocket-backed subscription with one driven by the test's
// `script`. `self.cursor` mirrors the real subscription's progress cursor,
// which ingestEvents reads back as `lastCursor`.
vi.mock("@atcute/jetstream", () => {
  class MockJetstreamSubscription {
    cursor: number | null = null;
    constructor(opts: { cursor?: number }) {
      this.cursor = typeof opts?.cursor === "number" ? opts.cursor : null;
    }
    async *[Symbol.asyncIterator]() {
      if (!jetstream.script) throw new Error("test did not set jetstream.script");
      yield* jetstream.script(this);
    }
  }
  return { JetstreamSubscription: MockJetstreamSubscription };
});

import {
  ingestEvents,
  resolveScheduledIngestBudget,
  SCHEDULED_INGEST_METADATA_BYTES,
} from "../src/index";
import { resolveConfig } from "../src/index";
import type { ContrailConfig } from "../src/index";

const silentLogger = { log() {}, warn() {}, error() {} };

function commitEvent(
  did: string,
  collection: string,
  time_us: number,
  rkey: string,
  options: {
    revision?: string;
    record?: Record<string, unknown>;
    cid?: string;
  } = {},
) {
  return {
    kind: "commit" as const,
    time_us,
    did,
    commit: {
      rev: options.revision ?? String(time_us),
      collection,
      operation: "create" as const,
      rkey,
      cid: options.cid ?? "bafy" + rkey,
      record: options.record ?? {
        name: "Test Event",
        startsAt: "2026-04-01T10:00:00Z",
        mode: "online",
      },
    },
  };
}

function budget(overrides: Partial<{
  maxDrainMs: number;
  maxCandidates: number;
  maxSerializedBytes: number;
}> = {}) {
  return {
    maxDrainMs: 5_000,
    maxCandidates: 100,
    maxSerializedBytes: 1024 * 1024,
    ...overrides,
  };
}

/** A discoverable-only config — events flow straight into `collected`. */
function discoverableConfig(): ContrailConfig {
  return {
    ...resolveConfig({
      namespace: "com.example",
      collections: {
        event: { collection: "community.lexicon.calendar.event" },
      },
    }),
    logger: silentLogger,
  };
}

/** A config with a dependent collection so unknown-DID events get filtered. */
function dependentConfig(): ContrailConfig {
  return {
    ...resolveConfig({
      namespace: "com.example",
      collections: {
        event: { collection: "community.lexicon.calendar.event" },
        follow: { collection: "app.bsky.graph.follow", discover: false },
      },
    }),
    logger: silentLogger,
  };
}

/** Reject if `p` hasn't settled within `ms` — turns a hang into a test failure
 *  instead of a frozen run. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ingestEvents did not return within ${ms}ms (${label})`)),
      ms,
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

describe("ingestEvents — bounded by the safety timeout (om-dua7)", () => {
  beforeEach(() => {
    jetstream.script = null;
    jetstream.abort = false;
  });

  it("returns within the safety timeout when the stream replays history then goes quiet", async () => {
    jetstream.script = async function* (self: { cursor: number | null }) {
      // One historical commit (time_us in the past, so never "caught up").
      self.cursor = 1_000_000;
      yield commitEvent("did:plc:author", "community.lexicon.calendar.event", 1_000_000, "evt1");
      // Quiet stream: no further events ever arrive.
      await new Promise(() => {});
    };

    const result = await withTimeout(
      ingestEvents(discoverableConfig(), 999_999, 150),
      2_000,
      "quiet stream",
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].uri).toBe(
      "at://did:plc:author/community.lexicon.calendar.event/evt1",
    );
    expect(result.events[0].source).toEqual({
      id: "jetstream",
      time_us: 1_000_000,
      revision: "1000000",
      cursor: "1000000",
    });
    // The replayed cursor must come back so the caller can persist it.
    expect(result.lastCursor).toBe(1_000_000);
    expect(result.stats.stopReason).toBe("drain-time");
  });

  it("never checkpoints past the last yielded event when the subscription buffers ahead", async () => {
    jetstream.script = async function* (self: { cursor: number | null }) {
      self.cursor = 1_000_000;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        1_000_000,
        "yielded",
      );
      // Mirrors @atcute receiving a second frame and moving its internal cursor
      // before the async iterator delivers that frame to Contrail.
      self.cursor = 2_000_000;
      await new Promise(() => {});
    };

    const result = await withTimeout(
      ingestEvents(discoverableConfig(), 999_999, 150),
      2_000,
      "buffered cursor",
    );

    expect(result.events).toHaveLength(1);
    expect(result.lastCursor).toBe(1_000_000);
    expect(result.stats.lastAccountedCursor).toBe(1_000_000);
  });

  it("returns by the safety timeout even when every arriving event is filtered out", async () => {
    const knownDids = new Set<string>(); // no known DIDs -> every event filtered
    jetstream.script = async function* (self) {
      let t = 1_000_000;
      for (let i = 0; i < 2_000 && !jetstream.abort; i++) {
        t += 1_000;
        self.cursor = t;
        yield commitEvent("did:plc:stranger", "app.bsky.graph.follow", t, "f" + i);
        await new Promise((r) => setTimeout(r, 2));
      }
    };

    try {
      const result = await withTimeout(
        ingestEvents(dependentConfig(), 999_999, 100, knownDids),
        2_000,
        "all-filtered flood",
      );

      expect(result.events).toHaveLength(0); // all filtered, nothing collected
      // ...but the cursor still advanced, so the caller persists forward progress.
      expect(result.lastCursor).not.toBeNull();
      expect(result.lastCursor).toBeGreaterThan(1_000_000);
      expect(result.stats.stopReason).toBe("drain-time");
      expect(result.stats.lastAccountedCursor).toBe(result.lastCursor);
    } finally {
      jetstream.abort = true;
    }
  });

  it("keeps a dependent event after the same cycle discovers its actor", async () => {
    const liveUs = Date.now() * 1000 + 5_000_000;
    const knownDids = new Set<string>();
    jetstream.script = async function* (self) {
      self.cursor = 1_000_000;
      yield commitEvent(
        "did:plc:new",
        "community.lexicon.calendar.event",
        1_000_000,
        "primary",
      );
      self.cursor = liveUs;
      yield commitEvent(
        "did:plc:new",
        "app.bsky.graph.follow",
        liveUs,
        "dependent",
      );
    };

    const result = await ingestEvents(
      dependentConfig(),
      999_999,
      5_000,
      knownDids,
    );
    expect(result.events.map((event) => event.rkey)).toEqual([
      "primary",
      "dependent",
    ]);
  });

  it("breaks via 'caught up to present' and returns the batch + cursor when a kept event reaches the live edge", async () => {
    // `live` is >= ingestEvents' startTimeUs (captured at the call below), so the
    // 5s safety timeout is irrelevant — the exit must be the caught-up break.
    const liveUs = Date.now() * 1000 + 5_000_000;
    jetstream.script = async function* (self) {
      self.cursor = 1_000_000;
      yield commitEvent("did:plc:author", "community.lexicon.calendar.event", 1_000_000, "hist");
      self.cursor = liveUs;
      yield commitEvent("did:plc:author", "community.lexicon.calendar.event", liveUs, "live");
      // Must NOT be reached: the caught-up break fires on `live` before this.
      self.cursor = liveUs + 1_000;
      yield commitEvent("did:plc:author", "community.lexicon.calendar.event", liveUs + 1_000, "after");
      await new Promise(() => {});
    };

    const result = await withTimeout(
      ingestEvents(discoverableConfig(), 999_999, 5_000),
      2_000,
      "caught-up kept",
    );

    expect(result.events.map((e) => e.rkey)).toEqual(["hist", "live"]);
    expect(result.lastCursor).toBe(liveUs);
    expect(result.stats.stopReason).toBe("head");
  });

  it("caught-up break fires even on a filtered live event, deferring a following kept event to the next cycle", async () => {
    // Behavior change vs the pre-fix loop: filtering now uses early `return`, so
    // the caught-up check runs after a filtered event too. A filtered event at
    // the live edge breaks the loop BEFORE the kept event that follows it.
    // Pre-fix (`continue`) would have skipped the check, collected `evt`, and
    // broken on it with cursor liveUs+1000.
    const liveUs = Date.now() * 1000 + 5_000_000;
    const knownDids = new Set<string>(); // empty -> the follow is filtered (unknown DID)
    jetstream.script = async function* (self) {
      self.cursor = liveUs;
      yield commitEvent("did:plc:stranger", "app.bsky.graph.follow", liveUs, "f1");
      self.cursor = liveUs + 1_000;
      yield commitEvent("did:plc:author", "community.lexicon.calendar.event", liveUs + 1_000, "evt");
      await new Promise(() => {});
    };

    const result = await withTimeout(
      ingestEvents(dependentConfig(), 999_999, 5_000, knownDids),
      2_000,
      "caught-up filtered",
    );

    expect(result.events).toHaveLength(0); // kept `evt` deferred, not collected this cycle
    expect(result.lastCursor).toBe(liveUs); // broke at the filtered event, before `evt`
  });

  it("collects every event when they flow fast but within the safety timeout (the next()/timeout race drops nothing)", async () => {
    const N = 25;
    jetstream.script = async function* (self) {
      let t = 1_000_000; // all historical, so caught-up never fires; deadline ends it
      for (let i = 0; i < N; i++) {
        t += 1_000;
        self.cursor = t;
        // A real await before each yield forces next() down the pending-promise
        // path (not the queue fast-path), so this exercises the race directly.
        await new Promise((r) => setTimeout(r, 1));
        yield commitEvent("did:plc:author", "community.lexicon.calendar.event", t, "e" + i);
      }
      await new Promise(() => {}); // then quiet -> safety timeout returns the batch
    };

    const result = await withTimeout(
      ingestEvents(discoverableConfig(), 999_999, 300),
      2_000,
      "fast flow",
    );

    expect(result.events).toHaveLength(N);
  });

  it("captures #identity events as handle updates through the ingest path", async () => {
    jetstream.script = async function* (self) {
      self.cursor = 1_000_000;
      yield {
        kind: "identity" as const,
        time_us: 1_000_000,
        did: "did:plc:author",
        identity: {
          did: "did:plc:author",
          handle: "alice.test",
          seq: 1,
          time: "2026-04-01T10:00:00Z",
        },
      };
      await new Promise(() => {}); // quiet -> safety timeout returns
    };

    const result = await withTimeout(
      ingestEvents(discoverableConfig(), 999_999, 150),
      2_000,
      "identity",
    );

    expect(result.identityUpdates.get("did:plc:author")).toBe("alice.test");
    expect(result.events).toHaveLength(0); // identity events are not record commits
  });

  it("validates every scheduled work threshold", () => {
    expect(() => resolveScheduledIngestBudget({ maxCandidates: 0 })).toThrow(
      "maxCandidates must be a positive finite integer",
    );
    expect(() =>
      resolveScheduledIngestBudget({ maxSerializedBytes: Number.NaN }),
    ).toThrow("maxSerializedBytes must be a positive finite integer");
    expect(() => resolveScheduledIngestBudget({ maxDrainMs: 1.5 })).toThrow(
      "maxDrainMs must be a positive finite integer",
    );
  });

  it("stops an infinite hot stream at exactly maxCandidates without another next()", async () => {
    let produced = 0;
    jetstream.script = async function* (self) {
      for (let index = 0; !jetstream.abort; index++) {
        produced++;
        self.cursor = 1_000_000 + index;
        yield commitEvent(
          "did:plc:author",
          "community.lexicon.calendar.event",
          self.cursor,
          `hot-${index}`,
        );
      }
    };

    const result = await ingestEvents(
      discoverableConfig(),
      999_999,
      budget({ maxCandidates: 3 }),
    );

    expect(result.events).toHaveLength(3);
    expect(produced).toBe(3);
    expect(result.stats).toMatchObject({
      observedSourceItems: 3,
      retainedCandidates: 3,
      stopReason: "count",
      lastAccountedCursor: 1_000_002,
      safeEndingCursor: 1_000_002,
    });
  });

  it("retains the byte-threshold-crossing candidate and does not split equal cursors", async () => {
    const firstRecord = { value: "a" };
    const secondRecord = { value: "bbbb" };
    const encoder = new TextEncoder();
    const firstBytes =
      SCHEDULED_INGEST_METADATA_BYTES +
      encoder.encode(JSON.stringify(firstRecord)).byteLength;
    const secondBytes =
      SCHEDULED_INGEST_METADATA_BYTES +
      encoder.encode(JSON.stringify(secondRecord)).byteLength;
    const byteThreshold = firstBytes + 1;
    let produced = 0;
    jetstream.script = async function* (self) {
      self.cursor = 2_000_000;
      produced++;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        2_000_000,
        "same-cursor-1",
        { record: firstRecord },
      );
      produced++;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        2_000_000,
        "same-cursor-2",
        { record: secondRecord },
      );
      produced++;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        2_000_001,
        "not-requested",
      );
    };

    const result = await ingestEvents(
      discoverableConfig(),
      999_999,
      budget({ maxSerializedBytes: byteThreshold }),
    );

    expect(result.events.map((event) => event.rkey)).toEqual([
      "same-cursor-1",
      "same-cursor-2",
    ]);
    expect(produced).toBe(2);
    expect(result.stats.stopReason).toBe("bytes");
    expect(result.stats.serializedCandidateBytes).toBe(firstBytes + secondBytes);
    expect(result.stats.serializedCandidateBytes - byteThreshold).toBeLessThanOrEqual(
      secondBytes,
    );
    expect(result.lastCursor).toBe(2_000_000);
  });

  it("drops only exact source observations and retains genuine revisions", async () => {
    jetstream.script = async function* (self) {
      self.cursor = 3_000_000;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        3_000_000,
        "record",
        { revision: "rev-1", record: { b: 2, a: 1 } },
      );
      // Same source slot and normalized payload, despite object key order.
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        3_000_000,
        "record",
        { revision: "rev-1", record: { a: 1, b: 2 } },
      );
      self.cursor = 3_000_001;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        3_000_001,
        "record",
        { revision: "rev-2", record: { a: 2, b: 2 } },
      );
    };

    const result = await ingestEvents(
      discoverableConfig(),
      999_999,
      budget(),
    );

    expect(result.events.map((event) => event.source?.revision)).toEqual([
      "rev-1",
      "rev-2",
    ]);
    expect(result.stats.exactDuplicatesDropped).toBe(1);
    expect(result.stats.retainedCandidates).toBe(2);
    expect(result.stats.lastAccountedCursor).toBe(3_000_001);
  });

  it("advances the accounted cursor through filtered and duplicate observations", async () => {
    const knownDids = new Set<string>();
    jetstream.script = async function* (self) {
      self.cursor = 4_000_000;
      const original = commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        4_000_000,
        "kept",
      );
      yield original;
      yield original;
      self.cursor = 4_000_001;
      yield commitEvent(
        "did:plc:stranger",
        "app.bsky.graph.follow",
        4_000_001,
        "filtered",
      );
    };

    const result = await ingestEvents(
      dependentConfig(),
      999_999,
      budget(),
      knownDids,
    );

    expect(result.events).toHaveLength(1);
    expect(result.stats.exactDuplicatesDropped).toBe(1);
    expect(result.stats.sourceScopeFiltered).toBe(1);
    expect(result.stats.observedSourceItems).toBe(3);
    expect(result.lastCursor).toBe(4_000_001);
  });

  it("never regresses the safe cursor when a pooled transport replays older overlap", async () => {
    const startingCursor = 6_000_000;
    jetstream.script = async function* (self) {
      self.cursor = startingCursor - 500;
      yield commitEvent(
        "did:plc:author",
        "community.lexicon.calendar.event",
        startingCursor - 500,
        "rolled-back",
      );
    };
    const config = {
      ...discoverableConfig(),
      jetstreams: ["wss://one.test", "wss://two.test"],
    };

    const result = await ingestEvents(
      config,
      startingCursor,
      budget({ maxCandidates: 1 }),
    );

    expect(result.events).toHaveLength(1);
    expect(result.stats.lastAccountedCursor).toBe(startingCursor - 500);
    expect(result.lastCursor).toBe(startingCursor);
    expect(result.stats.safeEndingCursor).toBe(startingCursor);
  });

  it("keeps source-inconsistency diagnostics and normal logs bounded", async () => {
    const logs: unknown[][] = [];
    const config = {
      ...discoverableConfig(),
      logger: {
        log: (...args: unknown[]) => logs.push(args),
        warn: (...args: unknown[]) => logs.push(args),
        error: (...args: unknown[]) => logs.push(args),
      },
    };
    jetstream.script = async function* (self) {
      self.cursor = 5_000_000;
      for (let index = 0; index < 50; index++) {
        yield commitEvent(
          "did:plc:author",
          "community.lexicon.calendar.event",
          5_000_000,
          "inconsistent",
          { revision: "same", record: { value: index } },
        );
      }
    };

    const result = await ingestEvents(config, 999_999, budget());

    expect(result.events).toHaveLength(50);
    expect(result.stats.sourceInconsistencies).toBe(49);
    expect(result.stats.diagnosticSamples).toHaveLength(5);
    expect(result.stats.diagnosticSamplesOmitted).toBe(44);
    expect(logs).toHaveLength(0);
  });
});
