import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ContrailConfig,
  Database,
  PersistentJetstreamSubscription,
} from "../src/index";
import {
  FEED_PRUNE_RECOVERY_INTERVAL_MS,
  FEED_PRUNE_SWEEP_ACTORS,
  resolveConfig,
} from "../src/index";
import {
  createTestDb,
  createTestDbWithSchema,
  feedUris,
  GROWN_FEED,
  seedFollow,
  seedGrownFeed,
  TEST_CONFIG,
} from "./helpers";
import { runPersistent } from "../src/index";
import { JetstreamLiveHistoryExpiredError } from "../src/core/jetstream-live";
import {
  getLastCursor,
  getServingSourcePosition,
  queryRecords,
} from "../src/index";
import { initSchema } from "../src/index";
import { saveJetstreamCursor } from "../src/core/db/records";

vi.mock("../src/core/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/identity")>();
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
function mockSubscription(
  events: Array<{
    kind: string;
    did: string;
    time_us: number;
    commit?: any;
  }>,
): PersistentJetstreamSubscription {
  let aborted = false;
  return {
    cursor: 0,
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (aborted) return { value: undefined, done: true as const };
          if (i < events.length) {
            const event = events[i++]!;
            return {
              value: { ...event, seq: event.time_us },
              done: false as const,
            };
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
  it("rejects a raw-entry ordered-source mismatch before opening the stream", async () => {
    await saveJetstreamCursor(db, 42, {
      source: "jetstream",
      epoch: "original-epoch",
    });
    let subscriptionCreated = false;

    await expect(
      runPersistent(
        db,
        {
          ...TEST_CONFIG,
          orderedSource: { source: "jetstream", epoch: "changed-epoch" },
        },
        {
          createSubscription: () => {
            subscriptionCreated = true;
            return mockSubscription([]);
          },
        },
      ),
    ).rejects.toThrow("does not match durable source position");
    expect(subscriptionCreated).toBe(false);
  });

  it("persists the initial timestamp bridge before its first source pull", async () => {
    const bridge = 1_788_008_906_865_272;
    const controller = new AbortController();
    let durableCursorDuringPull: number | null = null;

    await runPersistent(db, TEST_CONFIG, {
      signal: controller.signal,
      createSubscription: (cursor) => {
        expect(cursor).toBeNull();
        return {
          cursor: bridge,
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                durableCursorDuringPull = await getLastCursor(db);
                controller.abort();
                return { value: undefined, done: true as const };
              },
            };
          },
        };
      },
    });

    expect(durableCursorDuringPull).toBe(bridge);
    expect(await getLastCursor(db)).toBe(bridge);
  });

  it("fails instead of retrying forever when live retention has expired", async () => {
    const expired = new JetstreamLiveHistoryExpiredError("cursor too old");
    await expect(
      runPersistent(db, TEST_CONFIG, {
        createSubscription: () =>
          ({
            async *[Symbol.asyncIterator]() {
              throw expired;
            },
          }) as any,
      }),
    ).rejects.toBe(expired);
  });

  it("flushes records and the ordered source position atomically", async () => {
    const config = resolveConfig({
      ...TEST_CONFIG,
      orderedSource: { source: "jetstream", epoch: "persistent-test" },
    });
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
    const promise = runPersistent(db, config, {
      batchSize: 50,
      flushIntervalMs: 60_000, // high so only batch size triggers flush
      signal: controller.signal,
      createSubscription: (_cursor, subscriptionSignal) => {
        expect(subscriptionSignal).toBe(controller.signal);
        return mockSubscription(events);
      },
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
    expect(await getServingSourcePosition(db)).toMatchObject({
      position: {
        source: "jetstream",
        epoch: "persistent-test",
        cursor: "1049",
      },
    });
  });

  it("keeps dependent events discovered in the same flush batch", async () => {
    const config = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: { collection: "com.example.event" },
        follow: {
          collection: "app.bsky.graph.follow",
          discover: false,
          subjectField: "subject",
        },
      },
    });
    const localDb = createTestDb();
    const did = "did:plc:new";
    const events = [
      {
        kind: "commit",
        did,
        time_us: 1000,
        commit: {
          collection: "com.example.event",
          operation: "create",
          rkey: "primary",
          cid: "primary-cid",
          record: { name: "Primary" },
        },
      },
      {
        kind: "commit",
        did,
        time_us: 1001,
        commit: {
          collection: "app.bsky.graph.follow",
          operation: "create",
          rkey: "dependent",
          cid: "dependent-cid",
          record: { subject: did },
        },
      },
    ];
    const controller = new AbortController();
    const promise = runPersistent(localDb, config, {
      batchSize: 2,
      flushIntervalMs: 60_000,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await promise;

    expect(
      (await queryRecords(localDb, config, { collection: "event" })).records,
    ).toHaveLength(1);
    expect(
      (await queryRecords(localDb, config, { collection: "follow" })).records,
    ).toHaveLength(1);
  });

  it("keeps scoped publishers independent of known actors and checkpoints filtered traffic", async () => {
    const items = "app.bsky.graph.listitem";
    const config = resolveConfig({
      namespace: "com.example", profiles: [], constellation: false,
      collections: { item: { collection: items, repos: ["did:plc:bot"] } },
    });
    const localDb = createTestDb();
    const events = ["did:plc:bot", "did:plc:other"].map((did, i) => ({
      kind: "commit", did, time_us: 1000 + i,
      commit: { collection: items, operation: "create", rkey: "one", cid: "cid-one", record: { subject: "did:plc:person" } },
    }));
    const controller = new AbortController();
    const promise = runPersistent(localDb, config, {
      batchSize: 10, flushIntervalMs: 60_000, signal: controller.signal,
      createSubscription: () => mockSubscription(events),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await promise;
    expect((await queryRecords(localDb, config, { collection: "item" })).records.map((r) => r.did)).toEqual(["did:plc:bot"]);
    expect(await getLastCursor(localDb)).toBe(1001);
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

  it("drops records that fail a collection's recordFilter", async () => {
    // Filter accepts only events whose `name` contains "keep". The other
    // events have well-formed records but should never reach the DB.
    const filterConfig = resolveConfig({
      namespace: "com.example",
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          recordFilter: (r) =>
            typeof r.name === "string" && r.name.includes("keep"),
        },
      },
    });

    const freshDb = createTestDb();
    await initSchema(freshDb, filterConfig);

    const events = [
      {
        kind: "commit" as const,
        did: "did:plc:a",
        time_us: 7000,
        commit: {
          collection: "community.lexicon.calendar.event",
          operation: "create",
          rkey: "drop1",
          cid: "c1",
          record: { name: "drop me", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
        },
      },
      {
        kind: "commit" as const,
        did: "did:plc:b",
        time_us: 7001,
        commit: {
          collection: "community.lexicon.calendar.event",
          operation: "create",
          rkey: "keep1",
          cid: "c2",
          record: { name: "keep this", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
        },
      },
    ];

    const controller = new AbortController();
    const promise = runPersistent(freshDb, filterConfig, {
      batchSize: 100,
      flushIntervalMs: 50,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await promise;

    const result = await queryRecords(freshDb, filterConfig, {
      collection: "community.lexicon.calendar.event",
      limit: 100,
    });
    expect(result.records.length).toBe(1);
    expect(result.records[0]!.uri).toContain("/keep1");
  });

  it("skips non-commit events", async () => {
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind("did:plc:someone", "oldhandle.test", "https://pds.test", 1)
      .run();
    const events = [
      {
        kind: "identity" as const,
        did: "did:plc:someone",
        time_us: 4000,
        identity: { did: "did:plc:someone", handle: "newhandle.test", seq: 1, time: "2026-04-01T10:00:00Z" },
      },
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
    // Identity events batch-update the identities table even though they don't
    // produce records.
    const row = await db
      .prepare("SELECT handle FROM identities WHERE did = ?")
      .bind("did:plc:someone")
      .first<{ handle: string }>();
    expect(row?.handle).toBe("newhandle.test");
  });

  it("checkpoints an identity-only v2 range", async () => {
    const events = [
      {
        kind: "identity" as const,
        did: "did:plc:identity-only",
        time_us: 4_100,
        identity: {
          did: "did:plc:identity-only",
          handle: "identity-only.test",
          time: "2026-04-01T10:00:00Z",
        },
      },
    ];
    const controller = new AbortController();
    const promise = runPersistent(db, TEST_CONFIG, {
      batchSize: 100,
      flushIntervalMs: 50,
      signal: controller.signal,
      createSubscription: () => mockSubscription(events) as any,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await getLastCursor(db)).toBe(4_100);
    controller.abort();
    await promise;
  });

  it("runs the recovery feed sweep on a fully idle stream", async () => {
    // Regression: the feed sweep used to sit behind flush()'s early return when
    // the buffer was empty, so over-cap rows (a lowered cap, a bulk import)
    // never drained while Jetstream was quiet. The recovery clock starts at 0,
    // so the recovery sweep is due on the first idle timer flush.
    const EVENT = "community.lexicon.calendar.event";
    const feedConfig = resolveConfig({
      namespace: "com.example",
      collections: { event: { collection: EVENT } },
      feeds: { main: { targets: [{ collection: "event", maxItems: 2 }] } },
    });
    const feedDb = createTestDb();
    await initSchema(feedDb, feedConfig);

    // Seed five rows for one actor against a cap of two — over cap, predating
    // any ingest. No events will ever flow on this run.
    for (let i = 0; i < 5; i++) {
      await feedDb
        .prepare(
          "INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)"
        )
        .bind("did:plc:alice", `at://did:plc:alice/${EVENT}/${i}`, EVENT, 1000 + i)
        .run();
    }

    const controller = new AbortController();
    const promise = runPersistent(feedDb, feedConfig, {
      batchSize: 100,
      flushIntervalMs: 50,
      signal: controller.signal,
      createSubscription: () => mockSubscription([]) as any,
    });

    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await promise;

    const res = await feedDb
      .prepare(
        "SELECT COUNT(*) AS n FROM feed_items WHERE actor = ? AND collection = ?"
      )
      .bind("did:plc:alice", EVENT)
      .first<{ n: number }>();
    expect(Number(res?.n)).toBe(2);
  });

  it("prunes the feeds a flushed batch grew, and no others", async () => {
    const EVENT = "community.lexicon.calendar.event";
    const feedConfig = resolveConfig({
      namespace: "com.example",
      constellation: false,
      collections: { event: { collection: EVENT } },
      feeds: { main: { targets: [{ collection: "event", maxItems: 2 }] } },
    });
    const feedDb = createTestDb();
    await initSchema(feedDb, feedConfig);
    await seedGrownFeed(feedDb, EVENT);
    const { author, follower, bystander } = GROWN_FEED;

    // The loop keeps its recovery clock in memory, starting at 0. Pin the clock
    // inside the first recovery interval, so that pass isn't due and can't trim
    // feeds itself.
    const now = vi.spyOn(Date, "now").mockReturnValue(FEED_PRUNE_RECOVERY_INTERVAL_MS - 1);
    try {
      const controller = new AbortController();
      const promise = runPersistent(feedDb, feedConfig, {
        batchSize: 100,
        flushIntervalMs: 50,
        signal: controller.signal,
        createSubscription: () =>
          mockSubscription([
            {
              kind: "commit",
              did: author,
              time_us: 5000,
              commit: {
                collection: EVENT,
                operation: "create",
                rkey: "new",
                cid: "cidnew",
                record: { name: "New", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
              },
            },
          ]) as any,
      });
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      await promise;
    } finally {
      now.mockRestore();
    }

    const aliceFeed = await feedUris(feedDb, follower, EVENT);
    expect(aliceFeed).toHaveLength(2);
    expect(aliceFeed[0]).toBe(`at://${author}/${EVENT}/new`);
    expect(await feedUris(feedDb, bystander, EVENT)).toHaveLength(5);
  });

  it("sweeps a slice when a flushed batch grew more feeds than the prune's budget", async () => {
    const EVENT = "community.lexicon.calendar.event";
    const feedConfig = resolveConfig({
      namespace: "com.example",
      constellation: false,
      collections: { event: { collection: EVENT } },
      feeds: { main: { targets: [{ collection: "event", maxItems: 2 }] } },
    });
    const feedDb = createTestDb();
    await initSchema(feedDb, feedConfig);
    // The budget is FEED_PRUNE_SWEEP_ACTORS feeds per capped collection, and
    // there is one, so one more follower than that overflows it.
    const author = "did:plc:bob";
    for (let i = 0; i <= FEED_PRUNE_SWEEP_ACTORS; i++) {
      await seedFollow(feedDb, `f-${String(i).padStart(4, "0")}`, author);
    }
    // Over cap and unrelated to bob, first in actor order: only a sweep slice
    // reaches it.
    const bystander = "a-bystander";
    for (let i = 0; i < 5; i++) {
      await feedDb
        .prepare("INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)")
        .bind(bystander, `at://did:plc:old/${EVENT}/${i}`, EVENT, 1000 + i)
        .run();
    }

    // As above: keep the in-memory recovery pass from coming due.
    const now = vi.spyOn(Date, "now").mockReturnValue(FEED_PRUNE_RECOVERY_INTERVAL_MS - 1);
    try {
      const controller = new AbortController();
      const promise = runPersistent(feedDb, feedConfig, {
        batchSize: 100,
        flushIntervalMs: 50,
        signal: controller.signal,
        createSubscription: () =>
          mockSubscription([
            {
              kind: "commit",
              did: author,
              time_us: 5000,
              commit: {
                collection: EVENT,
                operation: "create",
                rkey: "new",
                cid: "cidnew",
                record: { name: "New", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
              },
            },
          ]) as any,
      });
      await new Promise((r) => setTimeout(r, 500));
      controller.abort();
      await promise;
    } finally {
      now.mockRestore();
    }

    // The fan-out reached every follower, so the batch did overflow.
    expect(await feedUris(feedDb, `f-${String(FEED_PRUNE_SWEEP_ACTORS).padStart(4, "0")}`, EVENT)).toHaveLength(1);
    expect(await feedUris(feedDb, bystander, EVENT)).toHaveLength(2);
  });

  it("retains dependent commits that arrive while a newly discovered actor's flush is in flight", async () => {
    const config = resolveConfig({
      namespace: "com.example",
      profiles: [],
      constellation: false,
      collections: {
        event: { collection: "com.example.event" },
        rsvp: { collection: "com.example.rsvp", discover: false },
      },
    });
    const rawDb = createTestDb();
    await initSchema(rawDb, config);

    let batchStarted!: () => void;
    const batchStartedPromise = new Promise<void>((r) => { batchStarted = r; });
    let releaseBatch!: () => void;
    const releaseBatchPromise = new Promise<void>((r) => { releaseBatch = r; });
    let slowedOnce = false;
    const slowDb: Database = {
      dialect: rawDb.dialect,
      prepare: (sql) => rawDb.prepare(sql),
      async batch(stmts) {
        if (!slowedOnce) {
          slowedOnce = true;
          batchStarted();
          await releaseBatchPromise;
        }
        return rawDb.batch(stmts);
      },
    };

    const alice = "did:plc:alice-inflight";
    const queue: any[] = [];
    let notifyNext: (() => void) | null = null;
    let streamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((r) => { streamStarted = r; });
    const pushEvent = (ev: any) => {
      queue.push(ev);
      notifyNext?.();
      notifyNext = null;
    };
    const controller = new AbortController();
    const subscription: PersistentJetstreamSubscription = {
      cursor: null,
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            streamStarted();
            while (queue.length === 0) {
              if (controller.signal.aborted) return { value: undefined, done: true as const };
              await new Promise<void>((resolve) => {
                notifyNext = resolve;
                controller.signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            const ev = queue.shift()!;
            return { value: { ...ev, seq: ev.time_us }, done: false as const };
          },
          return: async () => ({ value: undefined, done: true as const }),
        };
      },
    };

    const promise = runPersistent(slowDb, config, {
      batchSize: 100,
      flushIntervalMs: 30,
      signal: controller.signal,
      createSubscription: () => subscription,
    });

    await streamStartedPromise;

    // 1. Yield alice's discoverable event; timer starts flushing it and pauses mid-batch.
    pushEvent({
      kind: "commit",
      did: alice,
      time_us: 10_000,
      commit: {
        collection: "com.example.event",
        operation: "create",
        rkey: "ev1",
        cid: "cid-ev1",
        record: { name: "Launch" },
      },
    });
    await batchStartedPromise;

    // 2. While batch 1 is still in flight (before knownDids has alice), yield her dependent rsvp.
    pushEvent({
      kind: "commit",
      did: alice,
      time_us: 10_001,
      commit: {
        collection: "com.example.rsvp",
        operation: "create",
        rkey: "rsvp1",
        cid: "cid-rsvp1",
        record: { status: "going" },
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    // 3. Release batch 1, then abort so final flush commits the dependent rsvp.
    releaseBatch();
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    await promise;

    expect((await queryRecords(rawDb, config, { collection: "event" })).records).toHaveLength(1);
    expect((await queryRecords(rawDb, config, { collection: "rsvp" })).records).toHaveLength(1);
  });

  it("retains dependent commits and identity updates across a failed flush", async () => {
    const config = resolveConfig({
      namespace: "com.example",
      profiles: [],
      constellation: false,
      collections: {
        event: { collection: "com.example.event" },
        rsvp: { collection: "com.example.rsvp", discover: false },
      },
    });
    const rawDb = createTestDb();
    await initSchema(rawDb, config);

    const alice = "did:plc:alice-retry";
    const bob = "did:plc:bob-retry";
    await rawDb
      .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
      .bind(alice, "alice-old.test", "https://pds.test", 1)
      .run();
    await rawDb
      .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
      .bind(bob, "bob-old.test", "https://pds.test", 1)
      .run();

    let failedOnce = false;
    let firstFailureDone!: () => void;
    const firstFailurePromise = new Promise<void>((r) => { firstFailureDone = r; });
    const flakyDb: Database = {
      dialect: rawDb.dialect,
      prepare: (sql) => rawDb.prepare(sql),
      async batch(stmts) {
        if (!failedOnce) {
          failedOnce = true;
          firstFailureDone();
          throw new Error("transient D1 write failure");
        }
        return rawDb.batch(stmts);
      },
    };

    const queue: any[] = [];
    let notifyNext: (() => void) | null = null;
    let streamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((r) => { streamStarted = r; });
    const pushEvent = (ev: any) => {
      queue.push(ev);
      notifyNext?.();
      notifyNext = null;
    };
    const controller = new AbortController();
    const subscription: PersistentJetstreamSubscription = {
      cursor: null,
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            streamStarted();
            while (queue.length === 0) {
              if (controller.signal.aborted) return { value: undefined, done: true as const };
              await new Promise<void>((resolve) => {
                notifyNext = resolve;
                controller.signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            const ev = queue.shift()!;
            return { value: { ...ev, seq: ev.time_us }, done: false as const };
          },
          return: async () => ({ value: undefined, done: true as const }),
        };
      },
    };

    const promise = runPersistent(flakyDb, config, {
      batchSize: 100,
      flushIntervalMs: 40,
      signal: controller.signal,
      createSubscription: () => subscription,
      logger: { log() {}, warn() {}, error() {} },
    });

    await streamStartedPromise;

    // Buffer alice's discoverable event plus handle updates for alice & bob; first timer flush fails.
    pushEvent({
      kind: "commit",
      did: alice,
      time_us: 20_000,
      commit: {
        collection: "com.example.event",
        operation: "create",
        rkey: "ev1",
        cid: "cid-ev1",
        record: { name: "Retry Event" },
      },
    });
    pushEvent({ kind: "identity", did: alice, time_us: 20_001, identity: { handle: "alice-v1.test" } });
    pushEvent({ kind: "identity", did: bob, time_us: 20_002, identity: { handle: "bob-v1.test" } });

    await firstFailurePromise;
    await new Promise((r) => setTimeout(r, 10));

    // After the failed flush, alice sends a dependent rsvp and bob gets a newer handle.
    pushEvent({
      kind: "commit",
      did: alice,
      time_us: 20_003,
      commit: {
        collection: "com.example.rsvp",
        operation: "create",
        rkey: "rsvp1",
        cid: "cid-rsvp1",
        record: { status: "going" },
      },
    });
    pushEvent({ kind: "identity", did: bob, time_us: 20_004, identity: { handle: "bob-v2.test" } });

    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await promise;

    expect((await queryRecords(rawDb, config, { collection: "event" })).records).toHaveLength(1);
    expect((await queryRecords(rawDb, config, { collection: "rsvp" })).records).toHaveLength(1);
    const aliceRow = await rawDb.prepare("SELECT handle FROM identities WHERE did = ?").bind(alice).first<{ handle: string }>();
    const bobRow = await rawDb.prepare("SELECT handle FROM identities WHERE did = ?").bind(bob).first<{ handle: string }>();
    expect(aliceRow?.handle).toBe("alice-v1.test");
    expect(bobRow?.handle).toBe("bob-v2.test");
  });

  it("applies dependent deletes for rows inserted out-of-band after startup", async () => {
    const config = resolveConfig({
      namespace: "com.example",
      profiles: [],
      constellation: false,
      collections: {
        event: { collection: "com.example.event" },
        rsvp: { collection: "com.example.rsvp", discover: false },
      },
    });
    const localDb = createTestDb();
    await initSchema(localDb, config);

    const outOfBandDid = "did:plc:out-of-band";
    const rsvpUri = `at://${outOfBandDid}/com.example.rsvp/r1`;
    const queue: any[] = [];
    let notifyNext: (() => void) | null = null;
    const pushEvent = (ev: any) => {
      queue.push(ev);
      notifyNext?.();
      notifyNext = null;
    };
    const controller = new AbortController();
    let streamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((r) => { streamStarted = r; });

    const subscription: PersistentJetstreamSubscription = {
      cursor: 0,
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            streamStarted();
            while (queue.length === 0) {
              if (controller.signal.aborted) return { value: undefined, done: true as const };
              await new Promise<void>((resolve) => {
                notifyNext = resolve;
                controller.signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            const ev = queue.shift()!;
            return { value: { ...ev, seq: ev.time_us }, done: false as const };
          },
          return: async () => ({ value: undefined, done: true as const }),
        };
      },
    };

    const promise = runPersistent(localDb, config, {
      batchSize: 10,
      flushIntervalMs: 60_000,
      signal: controller.signal,
      createSubscription: () => subscription,
    });

    // Wait until runPersistent has already loaded its startup knownDids snapshot.
    await streamStartedPromise;

    // Insert a dependent row out-of-band (e.g. via notifyOfUpdate or backfill).
    await localDb
      .prepare(
        "INSERT INTO records_rsvp (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(rsvpUri, outOfBandDid, "r1", "cid-r1", JSON.stringify({ status: "going" }), 1000, 1000)
      .run();
    expect((await queryRecords(localDb, config, { collection: "rsvp" })).records).toHaveLength(1);

    // Now Jetstream delivers a delete for that dependent record.
    pushEvent({
      kind: "commit",
      did: outOfBandDid,
      time_us: 2000,
      commit: {
        collection: "com.example.rsvp",
        operation: "delete",
        rkey: "r1",
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await promise;

    expect((await queryRecords(localDb, config, { collection: "rsvp" })).records).toHaveLength(0);
  });
});
