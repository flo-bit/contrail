import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContrailConfig, Database } from "../src/core/types";
import { createTestDb, createTestDbWithSchema, TEST_CONFIG } from "./helpers";
import { runPersistent } from "../src/core/persistent";
import { getLastCursor, queryRecords } from "../src/core/db/records";
import { initSchema } from "../src/core/db/schema";

// Identity helpers live in @atmo-dev/contrail-base post-split. Mock there.
vi.mock("@atmo-dev/contrail-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atmo-dev/contrail-base")>();
  return {
    ...actual,
    refreshStaleIdentities: vi.fn().mockResolvedValue(undefined),
  };
});

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

  it("flushes buffered events on timer while subscription is still live", async () => {
    // Regression test for the idle-stream flush bug. Forces exactly one code
    // path — timer-driven flush — by:
    //   - batchSize=100 with only 3 events: batchSize flush can never fire
    //   - assert BEFORE controller.abort(): the finally-block's final flush
    //     can't contribute, so records in the DB prove the periodic timer ran
    // The mock subscription yields 3 events then hangs forever, mimicking a
    // Jetstream connection that goes quiet. The previous implementation only
    // checked the flush condition when a new event arrived, so those 3 events
    // would sit in memory until the next event or shutdown — which in prod
    // surfaces as "events published but never indexed."
    const events = Array.from({ length: 3 }, (_, i) => ({
      kind: "commit" as const,
      did: `did:plc:idle${i}`,
      time_us: 5000 + i,
      commit: {
        collection: "community.lexicon.calendar.event",
        operation: "create",
        rkey: `idle${i}`,
        cid: `cid${i}`,
        record: { name: `Idle ${i}`, startsAt: "2026-04-01T10:00:00Z", mode: "online" },
      },
    }));

    const controller = new AbortController();
    const promise = runPersistent(db, TEST_CONFIG, {
      batchSize: 100,
      flushIntervalMs: 100,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    // Wait well past the flush interval — no further events will arrive.
    await new Promise((r) => setTimeout(r, 500));

    // Assert BEFORE abort: the timer must have driven the flush on its own.
    const mid = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 100,
    });
    const idleUris = mid.records.map((r) => r.uri).filter((u) => u.includes("/idle"));
    expect(idleUris.length, "timer flush did not run while subscription was idle").toBe(3);

    controller.abort();
    await promise;
  });

  it("resolves config internally when given an unresolved ContrailConfig", async () => {
    // Regression test for the silent grouped-count bug: passing a raw
    // ContrailConfig (no `_resolved`) used to let total counts update while
    // grouped count columns stayed at 0. runPersistent must defensively
    // resolve so consumers of the raw export get the same behavior as those
    // going through the Contrail class wrapper.
    const rawConfig: ContrailConfig = {
      namespace: "com.example",
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          relations: {
            rsvps: {
              collection: "rsvp",
              groupBy: "status",
              groups: {
                going: "community.lexicon.calendar.rsvp#going",
                notgoing: "community.lexicon.calendar.rsvp#notgoing",
              },
            },
          },
        },
        rsvp: {
          collection: "community.lexicon.calendar.rsvp",
          references: {
            event: { collection: "event", field: "subject.uri" },
          },
        },
      },
    };
    // Sanity: the raw object must NOT have _resolved — that's the whole point.
    expect((rawConfig as any)._resolved).toBeUndefined();

    const freshDb = createTestDb();
    await initSchema(freshDb, rawConfig);

    const eventUri = "at://did:plc:alice/community.lexicon.calendar.event/evt1";
    const events = [
      {
        kind: "commit" as const,
        did: "did:plc:alice",
        time_us: 9000,
        commit: {
          collection: "community.lexicon.calendar.event",
          operation: "create",
          rkey: "evt1",
          cid: "cidE",
          record: { name: "E", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
        },
      },
      {
        kind: "commit" as const,
        did: "did:plc:alice",
        time_us: 9001,
        commit: {
          collection: "community.lexicon.calendar.rsvp",
          operation: "create",
          rkey: "r1",
          cid: "cidR",
          record: {
            subject: { uri: eventUri, cid: "cidE" },
            status: "community.lexicon.calendar.rsvp#going",
          },
        },
      },
    ];

    const controller = new AbortController();
    const promise = runPersistent(freshDb, rawConfig, {
      batchSize: 100,
      flushIntervalMs: 50,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await promise;

    // Query the raw count columns directly — using queryRecords would hide
    // the bug since it hydrates via the resolved config anyway.
    const row = await freshDb
      .prepare(`SELECT count_rsvp, count_rsvp_going FROM records_event WHERE uri = ?`)
      .bind(eventUri)
      .first<{ count_rsvp: number; count_rsvp_going: number }>();
    expect(row).not.toBeNull();
    expect(row!.count_rsvp).toBe(1);
    // This is the assertion that would fail before the fix.
    expect(row!.count_rsvp_going).toBe(1);
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
