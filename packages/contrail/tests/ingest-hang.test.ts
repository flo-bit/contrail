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

import { ingestEvents } from "../src/core/jetstream";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";

const silentLogger = { log() {}, warn() {}, error() {} };

function commitEvent(
  did: string,
  collection: string,
  time_us: number,
  rkey: string,
) {
  return {
    kind: "commit" as const,
    time_us,
    did,
    commit: {
      collection,
      operation: "create" as const,
      rkey,
      cid: "bafy" + rkey,
      record: { name: "Test Event", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
    },
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
    // The replayed cursor must come back so the caller can persist it.
    expect(result.lastCursor).toBe(1_000_000);
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
    } finally {
      jetstream.abort = true;
    }
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
});
