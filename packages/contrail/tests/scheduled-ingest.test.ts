import { beforeEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  initialCursor: 0,
  requestedCursors: [] as Array<number | null>,
  events: [] as Array<{
    kind: "commit";
    seq?: number;
    time_us: number;
    did: string;
    commit: {
      rev: string;
      collection: string;
      operation: "create";
      rkey: string;
      cid: string;
      record: unknown;
    };
  }>,
}));

vi.mock("../src/core/jetstream-live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/jetstream-live")>();
  class MockJetstreamSubscription {
    cursor: number | null;
    private readonly start: number | null;

    constructor(options: { cursor?: number }) {
      this.start = options.cursor ?? source.initialCursor;
      this.cursor = this.start;
      source.requestedCursors.push(this.start);
    }

    async *[Symbol.asyncIterator]() {
      for (const event of source.events) {
        const seq = (event as { seq?: number }).seq ?? event.time_us;
        // V2 replay is inclusive at the server and de-duplicated by the client.
        if (
          this.start !== null &&
          this.start < 1_000_000_000_000_000 &&
          seq <= this.start
        ) continue;
        this.cursor = seq;
        yield { ...event, seq };
      }
    }
  }

  return { ...actual, JetstreamLiveSubscription: MockJetstreamSubscription };
});

import {
  getLastCursor,
  initSchema,
  resolveConfig,
  runIngestCycle,
  type Database,
  type Logger,
} from "../src/index";
import { saveJetstreamCursor } from "../src/core/db/records";
import { createTestDb } from "./helpers";

const COLLECTION = "com.example.event";

function commit(time_us: number, rkey: string, seq = time_us) {
  return {
    kind: "commit" as const,
    seq,
    time_us,
    did: "actor",
    commit: {
      rev: String(time_us),
      collection: COLLECTION,
      operation: "create" as const,
      rkey,
      cid: `bafy-${rkey}`,
      record: { $type: COLLECTION, value: rkey },
    },
  };
}

function config(logger: Logger, dependent = false) {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    constellation: false,
    collections: dependent
      ? {
          event: { collection: COLLECTION },
          follow: { collection: "app.bsky.graph.follow", discover: false },
        }
      : { event: { collection: COLLECTION } },
    logger,
  });
}

function logger() {
  const lines: Array<{ level: "log" | "warn" | "error"; text: string }> = [];
  return {
    lines,
    value: {
      log: (...values: unknown[]) =>
        lines.push({ level: "log" as const, text: values.map(String).join(" ") }),
      warn: (...values: unknown[]) =>
        lines.push({ level: "warn" as const, text: values.map(String).join(" ") }),
      error: (...values: unknown[]) =>
        lines.push({ level: "error" as const, text: values.map(String).join(" ") }),
    },
  };
}

const budget = {
  maxDrainMs: 5_000,
  maxCandidates: 2,
  maxSerializedBytes: 1024 * 1024,
};

describe("bounded scheduled ingest cycles", () => {
  beforeEach(() => {
    source.initialCursor = 0;
    source.requestedCursors = [];
    source.events = [];
  });

  it("commits a capped cycle cursor and converges after restart", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value);
    const first = commit(1_000_001, "one");
    source.events = [first, first, commit(1_000_002, "two"), commit(1_000_003, "three")];

    await runIngestCycle(db, configured, budget);

    expect(await getLastCursor(db)).toBe(1_000_002);
    expect(
      (await db.prepare(`SELECT rkey FROM records_event ORDER BY time_us`).all<{ rkey: string }>())
        .results?.map((row) => row.rkey),
    ).toEqual(["one", "two"]);

    const firstSummary = output.lines.filter((line) =>
      line.text.startsWith("[ingest] cycle summary "),
    );
    expect(firstSummary).toHaveLength(1);
    expect(firstSummary[0]?.text).toContain('"stop_reason":"count"');
    expect(firstSummary[0]?.text).toContain('"exact_duplicates_dropped":1');
    expect(output.lines.some((line) => /candidate:|DUPLICATE/.test(line.text))).toBe(false);

    await runIngestCycle(db, configured, budget);

    expect(await getLastCursor(db)).toBe(1_000_003);
    expect(
      (await db.prepare(`SELECT rkey FROM records_event ORDER BY time_us`).all<{ rkey: string }>())
        .results?.map((row) => row.rkey),
    ).toEqual(["one", "two", "three"]);
  });

  it("uses unique v2 seqs when display timestamps are equal", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value);
    source.events = [
      commit(1_100_000, "same-time-a", 1_100_001),
      commit(1_100_000, "same-time-b", 1_100_002),
      commit(1_100_001, "after", 1_100_003),
    ];
    const oneCandidate = { ...budget, maxCandidates: 1 };

    for (const cursor of [1_100_001, 1_100_002, 1_100_003]) {
      await runIngestCycle(db, configured, oneCandidate);
      expect(await getLastCursor(db)).toBe(cursor);
    }
    expect(
      (await db.prepare("SELECT rkey FROM records_event ORDER BY rkey").all<{ rkey: string }>())
        .results?.map((row) => row.rkey),
    ).toEqual(["after", "same-time-a", "same-time-b"]);
    expect(source.requestedCursors).toEqual([0, 1_100_001, 1_100_002]);
  });

  it("restores actor scope from a projected record before replaying dependent siblings", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value, true);
    const timeUs = 1_200_000;
    source.events = [
      commit(timeUs, "discover-actor", 1_200_001),
      {
        ...commit(timeUs, "dependent-sibling", 1_200_002),
        commit: {
          ...commit(timeUs, "dependent-sibling", 1_200_002).commit,
          collection: "app.bsky.graph.follow",
        },
      },
    ];
    const oneCandidate = { ...budget, maxCandidates: 1 };

    await runIngestCycle(db, configured, oneCandidate);
    expect(
      await db.prepare("SELECT did FROM identities WHERE did = ?").bind("actor").first(),
    ).toBeNull();
    expect(
      await db.prepare("SELECT rkey FROM records_event").first<{ rkey: string }>(),
    ).toEqual({ rkey: "discover-actor" });

    // runIngestCycle receives no shared IngestState, modeling a fresh scheduled
    // isolate. The exact discovery event is dropped at the cursor boundary, so
    // durable projection scope must still admit its dependent sibling.
    await runIngestCycle(db, configured, oneCandidate);
    expect(
      await db.prepare("SELECT rkey FROM records_follow").first<{ rkey: string }>(),
    ).toEqual({ rkey: "dependent-sibling" });
  });

  it("persists a timestamp bridge, then transitions to a v2 seq", async () => {
    const db = createTestDb();
    const output = logger();
    const timestampCursor = 1_788_000_000_000_000;
    source.initialCursor = timestampCursor;

    await runIngestCycle(db, config(output.value), budget);

    expect(await getLastCursor(db)).toBe(timestampCursor);
    const summary = output.lines.find((line) =>
      line.text.startsWith("[ingest] cycle summary "),
    );
    expect(summary?.text).toContain('"starting_cursor":null');
    expect(summary?.text).toContain(`"safe_ending_cursor":${timestampCursor}`);

    source.events = [commit(timestampCursor, "between-empty-cycles", 7_000_000)];
    await runIngestCycle(db, config(output.value), budget);
    expect(source.requestedCursors).toEqual([timestampCursor, timestampCursor]);
    expect(await getLastCursor(db)).toBe(7_000_000);
    expect(
      await db
        .prepare("SELECT rkey FROM records_event WHERE rkey = ?")
        .bind("between-empty-cycles")
        .first<{ rkey: string }>(),
    ).toEqual({ rkey: "between-empty-cycles" });
  });

  it("rejects a raw-entry ordered-source mismatch before opening the stream", async () => {
    const db = createTestDb();
    const output = logger();
    const original = {
      ...config(output.value),
      orderedSource: { source: "jetstream", epoch: "original-epoch" },
    };
    await initSchema(db, original);
    await saveJetstreamCursor(db, 42, original.orderedSource);

    await expect(
      runIngestCycle(
        db,
        {
          ...original,
          orderedSource: { source: "jetstream", epoch: "changed-epoch" },
        },
        budget,
      ),
    ).rejects.toThrow("does not match durable source position");
    expect(source.requestedCursors).toHaveLength(0);
  });

  it("rejects an existing seq cursor whose originating service was never bound", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value);
    await initSchema(db, configured);
    await saveJetstreamCursor(db, 42);

    await expect(runIngestCycle(db, configured, budget)).rejects.toThrow(
      "has no pinned service identity",
    );
    expect(source.requestedCursors).toHaveLength(0);
  });

  it("binds seq cursors to one normalized durable service origin", async () => {
    const db = createTestDb();
    const output = logger();
    const base = config(output.value);
    source.initialCursor = 0;

    await runIngestCycle(
      db,
      { ...base, jetstreams: ["https://pinned.example/"] },
      budget,
    );
    expect(await getLastCursor(db)).toBe(0);

    // WS(S) and HTTP(S) spellings normalize to the same client origin.
    await runIngestCycle(
      db,
      { ...base, jetstreams: ["wss://pinned.example"] },
      budget,
    );
    const opened = source.requestedCursors.length;

    await expect(
      runIngestCycle(
        db,
        { ...base, jetstreams: ["https://different.example"] },
        budget,
      ),
    ).rejects.toThrow("does not match durable service");
    expect(source.requestedCursors).toHaveLength(opened);
  });

  it("rejects endpoint pools for scheduled ingestion before rollback can starve the cap", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = resolveConfig({
      ...config(output.value),
      jetstreams: ["wss://one.test", "wss://two.test"],
    });

    await expect(runIngestCycle(db, configured, budget)).rejects.toThrow(
      "Jetstream v2 ingestion requires exactly one pinned service",
    );
    expect(source.requestedCursors).toHaveLength(0);
  });

  it("batches the independently capped identity updates", async () => {
    const real = createTestDb();
    const output = logger();
    const configured = config(output.value);
    await initSchema(real, configured);
    await real
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, NULL, NULL, 0), (?, NULL, NULL, 0)",
      )
      .bind("actor-a", "actor-b")
      .run();

    let batchCalls = 0;
    const db: Database = {
      ...real,
      batch(statements) {
        batchCalls++;
        return real.batch(statements);
      },
    };
    source.events = [
      {
        kind: "identity",
        time_us: 1_000_001,
        did: "actor-a",
        identity: {
          did: "actor-a",
          handle: "a.test",
          seq: 1,
          time: "2026-04-01T10:00:00Z",
        },
      },
      {
        kind: "identity",
        time_us: 1_000_002,
        did: "actor-b",
        identity: {
          did: "actor-b",
          handle: "b.test",
          seq: 2,
          time: "2026-04-01T10:00:00Z",
        },
      },
    ] as unknown as typeof source.events;

    await runIngestCycle(db, configured, {
      ...budget,
      maxIdentityUpdates: 2,
    });

    expect(batchCalls).toBe(2); // one identity batch, then one cursor batch
    expect(
      (await real.prepare("SELECT did, handle FROM identities ORDER BY did").all())
        .results,
    ).toEqual([
      { did: "actor-a", handle: "a.test" },
      { did: "actor-b", handle: "b.test" },
    ]);
  });

  it("keeps admission diagnostics bounded as source volume grows", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value);
    source.events = Array.from({ length: 20 }, (_, index) => ({
      ...commit(1_250_000 + index, `invalid-${index}`),
      commit: {
        ...commit(1_250_000 + index, `invalid-${index}`).commit,
        record: `not-an-object-${index}`,
      },
    }));

    await runIngestCycle(db, configured, {
      ...budget,
      maxCandidates: 20,
    });

    expect(output.lines.filter((line) => line.level === "warn")).toHaveLength(0);
    const summaryLine = output.lines.find((line) =>
      line.text.startsWith("[ingest] cycle summary "),
    );
    const summary = JSON.parse(
      summaryLine!.text.slice("[ingest] cycle summary ".length),
    ) as {
      admission_policy_filtered: number;
      diagnostic_samples: string[];
      diagnostic_samples_omitted: number;
    };
    expect(summary.admission_policy_filtered).toBe(20);
    expect(summary.diagnostic_samples).toHaveLength(5);
    expect(summary.diagnostic_samples_omitted).toBe(15);
  });

  it("retains and orders two genuine revisions of one URI", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value);
    source.events = [
      commit(1_500_001, "same"),
      {
        ...commit(1_500_002, "same"),
        commit: {
          ...commit(1_500_002, "same").commit,
          cid: "bafy-newer",
          record: { $type: COLLECTION, value: "newer" },
        },
      },
    ];

    await runIngestCycle(db, configured, budget);

    const row = await db
      .prepare("SELECT cid, record FROM records_event WHERE rkey = ?")
      .bind("same")
      .first<{ cid: string; record: string }>();
    expect(row?.cid).toBe("bafy-newer");
    expect(JSON.parse(row!.record)).toMatchObject({ value: "newer" });
    expect(await getLastCursor(db)).toBe(1_500_002);
  });

  it("checkpoints a filtered-only accounted range", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value, true);
    source.events = [
      {
        ...commit(2_000_001, "filtered"),
        did: "unknown-actor",
        commit: {
          ...commit(2_000_001, "filtered").commit,
          collection: "app.bsky.graph.follow",
        },
      },
    ];

    await runIngestCycle(db, configured, budget);

    expect(await getLastCursor(db)).toBe(2_000_001);
    const summary = output.lines.find((line) =>
      line.text.startsWith("[ingest] cycle summary "),
    );
    expect(summary?.text).toContain('"retained_candidates":0');
    expect(summary?.text).toContain('"source_scope_filtered":1');
    expect(summary?.text).toContain('"safe_ending_cursor":2000001');
  });
});
