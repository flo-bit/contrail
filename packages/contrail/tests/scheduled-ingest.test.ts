import { beforeEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  initialCursor: 0,
  requestedCursors: [] as Array<number | null>,
  events: [] as Array<{
    kind: "commit";
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

vi.mock("@atcute/jetstream", () => {
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
        // Model the supported source's resume coordinate: only events after the
        // committed cursor are delivered on the next scheduled connection.
        if (this.start !== null && event.time_us <= this.start) continue;
        this.cursor = event.time_us;
        yield event;
      }
    }
  }

  return { JetstreamSubscription: MockJetstreamSubscription };
});

import {
  getLastCursor,
  resolveConfig,
  runIngestCycle,
  type Logger,
} from "../src/index";
import { createTestDb } from "./helpers";

const COLLECTION = "com.example.event";

function commit(time_us: number, rkey: string) {
  return {
    kind: "commit" as const,
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

  it("resumes before a capped coarse cursor without skipping or recounting siblings", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = config(output.value);
    source.events = [
      commit(1_100_000, "same-cursor-a"),
      commit(1_100_000, "same-cursor-b"),
      commit(1_100_001, "after"),
    ];
    const oneCandidate = { ...budget, maxCandidates: 1 };

    await runIngestCycle(db, configured, oneCandidate);
    expect(await getLastCursor(db)).toBe(1_100_000);
    expect(
      (await db.prepare("SELECT rkey FROM records_event ORDER BY rkey").all<{ rkey: string }>())
        .results?.map((row) => row.rkey),
    ).toEqual(["same-cursor-a"]);

    await runIngestCycle(db, configured, oneCandidate);
    expect(await getLastCursor(db)).toBe(1_100_000);
    expect(
      (await db.prepare("SELECT rkey FROM records_event ORDER BY rkey").all<{ rkey: string }>())
        .results?.map((row) => row.rkey),
    ).toEqual(["same-cursor-a", "same-cursor-b"]);

    await runIngestCycle(db, configured, oneCandidate);
    expect(await getLastCursor(db)).toBe(1_100_001);
    expect(
      (await db.prepare("SELECT rkey FROM records_event ORDER BY rkey").all<{ rkey: string }>())
        .results?.map((row) => row.rkey),
    ).toEqual(["after", "same-cursor-a", "same-cursor-b"]);
    expect(source.requestedCursors).toEqual([0, 1_099_999, 1_099_999]);

    const summaries = output.lines
      .filter((line) => line.text.startsWith("[ingest] cycle summary "))
      .map((line) =>
        JSON.parse(line.text.slice("[ingest] cycle summary ".length)) as {
          retained_candidates: number;
          cursor_boundary_duplicates_dropped: number;
        },
      );
    expect(summaries.map((summary) => summary.retained_candidates)).toEqual([
      1,
      1,
      1,
    ]);
    expect(summaries[1]?.cursor_boundary_duplicates_dropped).toBe(1);
    expect(summaries[2]?.cursor_boundary_duplicates_dropped).toBe(2);
  });

  it("persists Atcute's captured initial cursor after an empty first drain", async () => {
    const db = createTestDb();
    const output = logger();
    source.initialCursor = 7_000_000;

    await runIngestCycle(db, config(output.value), budget);

    expect(await getLastCursor(db)).toBe(7_000_000);
    const summary = output.lines.find((line) =>
      line.text.startsWith("[ingest] cycle summary "),
    );
    expect(summary?.text).toContain('"starting_cursor":null');
    expect(summary?.text).toContain('"safe_ending_cursor":7000000');

    // An event sharing the captured microsecond is not skipped by an exclusive
    // resume API: the next cycle requests one microsecond earlier.
    source.events = [commit(7_000_000, "between-empty-cycles")];
    await runIngestCycle(db, config(output.value), budget);
    expect(source.requestedCursors).toEqual([7_000_000, 6_999_999]);
    expect(
      await db
        .prepare("SELECT rkey FROM records_event WHERE rkey = ?")
        .bind("between-empty-cycles")
        .first<{ rkey: string }>(),
    ).toEqual({ rkey: "between-empty-cycles" });
  });

  it("rejects endpoint pools for scheduled ingestion before rollback can starve the cap", async () => {
    const db = createTestDb();
    const output = logger();
    const configured = resolveConfig({
      ...config(output.value),
      jetstreams: ["wss://one.test", "wss://two.test"],
    });

    await expect(runIngestCycle(db, configured, budget)).rejects.toThrow(
      "scheduled ingestion requires exactly one pinned Jetstream endpoint",
    );
    expect(source.requestedCursors).toHaveLength(0);
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
