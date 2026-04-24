import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../src/core/types";
import { createTestDbWithSchema, TEST_CONFIG } from "./helpers";
import { runPersistent } from "../src/core/persistent";
import { getLastCursor, queryRecords } from "../src/core/db/records";

// Mock identity resolution to avoid network calls in tests
vi.mock("../src/core/identity", () => ({
  refreshStaleIdentities: vi.fn().mockResolvedValue(undefined),
}));

let db: Database;

beforeEach(async () => {
  db = await createTestDbWithSchema();
});

// Helper: create a mock async iterable that yields events then hangs until aborted
function mockSubscription(events: Array<{ kind: string; did: string; time_us: number; commit?: any }>) {
  let aborted = false;
  return {
    cursor: 0,
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (aborted) return { value: undefined, done: true as const };
          if (i < events.length) {
            return { value: events[i++], done: false as const };
          }
          // Hang until iterator is returned (abort)
          return new Promise<IteratorResult<any>>(() => {});
        },
        return: async () => {
          aborted = true;
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

describe("runPersistent", () => {
  it("flushes when batch size is reached", async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      kind: "commit" as const,
      did: `did:plc:user${i}`,
      time_us: 1000 + i,
      commit: {
        collection: "community.lexicon.calendar.event",
        operation: "create",
        rkey: `rkey${i}`,
        cid: `cid${i}`,
        record: { name: `Event ${i}`, startsAt: "2026-04-01T10:00:00Z", mode: "online" },
      },
    }));

    const controller = new AbortController();

    // After yielding 50 events, the mock hangs. Give it time to flush, then abort.
    const promise = runPersistent(db, TEST_CONFIG, {
      batchSize: 50,
      flushIntervalMs: 60_000, // high so only batch size triggers flush
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    // Wait for flush to complete
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await promise;

    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 100,
    });
    expect(result.records.length).toBe(50);

    const cursor = await getLastCursor(db);
    expect(cursor).toBe(1049); // last event's time_us
  });

  it("flushes on timer when buffer is not full", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      kind: "commit" as const,
      did: `did:plc:user${i}`,
      time_us: 2000 + i,
      commit: {
        collection: "community.lexicon.calendar.event",
        operation: "create",
        rkey: `timer${i}`,
        cid: `cid${i}`,
        record: { name: `Timer Event ${i}`, startsAt: "2026-04-01T10:00:00Z", mode: "online" },
      },
    }));

    const controller = new AbortController();

    const promise = runPersistent(db, TEST_CONFIG, {
      batchSize: 100, // high so timer triggers flush, not batch size
      flushIntervalMs: 100, // 100ms timer
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    // Wait for timer flush
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    await promise;

    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 100,
    });
    expect(result.records.length).toBe(10);
  });

  it("flushes remaining buffer on abort", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      kind: "commit" as const,
      did: `did:plc:user${i}`,
      time_us: 3000 + i,
      commit: {
        collection: "community.lexicon.calendar.event",
        operation: "create",
        rkey: `abort${i}`,
        cid: `cid${i}`,
        record: { name: `Abort Event ${i}`, startsAt: "2026-04-01T10:00:00Z", mode: "online" },
      },
    }));

    const controller = new AbortController();

    const promise = runPersistent(db, TEST_CONFIG, {
      batchSize: 100,
      flushIntervalMs: 60_000,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    // Let events be consumed, then abort before timer or batch triggers
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await promise;

    // The final flush in the finally block should have saved them
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 100,
    });
    expect(result.records.length).toBe(5);

    const cursor = await getLastCursor(db);
    expect(cursor).toBe(3004);
  });

  it("skips non-commit events", async () => {
    const events = [
      { kind: "identity" as const, did: "did:plc:someone", time_us: 4000 },
      {
        kind: "commit" as const,
        did: "did:plc:real",
        time_us: 4001,
        commit: {
          collection: "community.lexicon.calendar.event",
          operation: "create",
          rkey: "only1",
          cid: "cidonly",
          record: { name: "Only Event", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
        },
      },
    ];

    const controller = new AbortController();

    const promise = runPersistent(db, TEST_CONFIG, {
      batchSize: 100,
      flushIntervalMs: 100,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    await promise;

    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 100,
    });
    expect(result.records.length).toBe(1);
  });
});
