import { describe, expect, it } from "vitest";
import {
  ALLUVIUM_BOOTSTRAP_META_KEY,
  DEFAULT_ALLUVIUM_REWIND_US,
  SourceHistoryExpiredError,
  getAlluviumBootstrapState,
  loadAlluviumExport,
} from "../src/adapters/alluvium";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import {
  Contrail,
  getLastCursor,
  getServingSourcePosition,
  initSchema,
  queryRecords,
  resolveConfig,
} from "../src/index";
import { saveJetstreamCursor } from "../src/core/db/records";
import { bootstrapAlluviumDatabase } from "../src/workers/backfill";

const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const DID = "did:plc:alluviumsource";
const ENDPOINT = "https://alluvium.test";
const SOURCE = { id: "jetstream", epoch: "test-epoch" };
const NOW_MS = 1_800_000_000_000;
const HEAD_US = NOW_MS * 1_000 - 2_000_000;
/** A record last written a day before the head. */
const OLD_US = HEAD_US - 86_400_000_000;

interface Row {
  collection: string;
  rkey: string;
  name: string;
  timeUs?: number;
  createdAt?: string;
}

function uri(row: Row): string {
  return `at://${DID}/${row.collection}/${row.rkey}`;
}

function line(row: Row, index: number): string {
  return JSON.stringify({
    uri: uri(row),
    cid: `bafy-${row.rkey}`,
    rev: "3kabcdefghij2",
    time_us: row.timeUs ?? HEAD_US - 1_000_000 + index,
    record: {
      $type: row.collection,
      name: row.name,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    },
  });
}

interface ServiceOptions {
  rows: Row[];
  head?: Record<string, unknown>;
  /** Cut the first export response after this many lines, with no end line. */
  cutAfter?: number;
  /** Replace export line N (0-based, within a response) with raw text. */
  corrupt?: { at: number; text: string };
  /** Added to the record count the end line reports. */
  miscount?: number;
  /** The snapshot time /export reports, when it differs from the head's;
   * null to send no snapshot headers at all. */
  exportTimeUs?: number | null;
}

/** A fetch that behaves like the service's /alluvium/head and /export. */
function service(options: ServiceOptions) {
  const requests: URL[] = [];
  let exports = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/alluvium/head") {
      return Response.json(
        options.head ?? {
          cursor: 1_000,
          time_us: HEAD_US,
          excludes: ["app.bsky.*", "chat.bsky.*"],
          snapshot: "1000",
        },
      );
    }
    if (url.pathname !== "/export") return new Response("not found", { status: 404 });
    exports += 1;
    const wanted = new Set(url.searchParams.getAll("collection"));
    const after = url.searchParams.get("after");
    const start = after ? options.rows.findIndex((row) => uri(row) === after) + 1 : 0;
    const selected = options.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => index >= start && wanted.has(row.collection));
    let lines = selected.map(({ row, index }) => line(row, index));
    if (options.corrupt) lines[options.corrupt.at] = options.corrupt.text;
    const cut = exports === 1 && options.cutAfter !== undefined;
    if (cut) lines = lines.slice(0, options.cutAfter);
    else {
      lines.push(
        JSON.stringify({
          end: true,
          cursor: 1_000,
          time_us: HEAD_US,
          records: selected.length + (options.miscount ?? 0),
        }),
      );
    }
    const headTimeUs =
      typeof options.head?.time_us === "number" ? options.head.time_us : HEAD_US;
    const servedUs =
      options.exportTimeUs === undefined ? headTimeUs : options.exportTimeUs;
    return new Response(lines.map((text) => `${text}\n`).join(""), {
      headers: {
        "content-type": "application/x-ndjson",
        ...(servedUs === null
          ? {}
          : { "alluvium-cursor": "1000", "alluvium-time-us": String(servedUs) }),
      },
    });
  };
  return { fetchImpl, requests };
}

function config(orderedSource = true) {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    constellation: false,
    ...(orderedSource
      ? { orderedSource: { source: SOURCE.id, epoch: SOURCE.epoch } }
      : {}),
    collections: {
      event: { collection: EVENT },
      rsvp: { collection: RSVP },
    },
  });
}

async function freshDb(resolved = config()) {
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, resolved);
  return db;
}

const ROWS: Row[] = [
  { collection: EVENT, rkey: "e1", name: "one" },
  { collection: EVENT, rkey: "e2", name: "two" },
  { collection: EVENT, rkey: "e3", name: "three" },
  { collection: RSVP, rkey: "r1", name: "yes", timeUs: OLD_US },
  { collection: RSVP, rkey: "r2", name: "no" },
];

describe("Alluvium export bootstrap", () => {
  it("pins the head, loads the export in resumable batches, and hands off by time", async () => {
    const resolved = config();
    const db = await freshDb(resolved);
    const { fetchImpl, requests } = service({ rows: ROWS });

    const result = await loadAlluviumExport(db, resolved, {
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: fetchImpl,
      now: () => NOW_MS,
      transport: { batchSize: 2, maxAttempts: 2 },
    });

    const liveCursorUs = HEAD_US - DEFAULT_ALLUVIUM_REWIND_US;
    expect(result).toEqual({
      handoff: { source: SOURCE.id, epoch: SOURCE.epoch, cursor: String(liveCursorUs) },
      liveCursor: liveCursorUs,
      resumed: false,
      alreadyComplete: false,
      recordsLoaded: 5,
    });
    expect(await getLastCursor(db)).toBe(liveCursorUs);
    expect((await getServingSourcePosition(db))?.position).toEqual(result.handoff);
    expect(await getAlluviumBootstrapState(db)).toMatchObject({
      phase: "complete",
      liveCursorUs,
      after: null,
    });

    const exportRequest = requests.find((url) => url.pathname === "/export")!;
    expect(exportRequest.searchParams.getAll("collection")).toEqual([EVENT, RSVP]);

    // First batch (e1, e2) has source_time_us capped at liveCursorUs; second
    // batch (e3, r1) has source_time_us capped at OLD_US (r1's observation time).
    const versions = (
      await db
        .prepare("SELECT rkey, source_time_us FROM record_versions ORDER BY rkey")
        .all<{ rkey: string; source_time_us: number }>()
    ).results;
    expect(Object.fromEntries(versions.map((v) => [v.rkey, v.source_time_us]))).toEqual({
      e1: liveCursorUs,
      e2: liveCursorUs,
      e3: OLD_US,
      r1: OLD_US,
      r2: liveCursorUs,
    });
  });

  it("dates each snapshot record by when it was seen, not by its batch's oldest record", async () => {
    const resolved = config();
    const db = await freshDb(resolved);
    const createdAt = "2026-01-03T00:00:00Z";
    const createdUs = Date.parse(createdAt) * 1000;
    const headUs = createdUs + 600_000_000;
    const rows: Row[] = [
      { collection: EVENT, rkey: "old", name: "old", timeUs: createdUs - 86_400_000_000 },
      { collection: EVENT, rkey: "early", name: "early", timeUs: createdUs - 5, createdAt },
      { collection: EVENT, rkey: "seen", name: "seen", timeUs: createdUs + 5, createdAt },
    ];
    const { fetchImpl } = service({
      rows,
      head: { cursor: 10, time_us: headUs, excludes: [] },
    });

    await loadAlluviumExport(db, resolved, {
      endpoint: ENDPOINT,
      source: SOURCE,
      collections: [EVENT],
      fetch: fetchImpl,
      now: () => Math.floor(headUs / 1000) + 1_000,
      transport: { batchSize: 10 },
    });

    const loaded = (
      await db
        .prepare(
          `SELECT r.rkey, r.time_us, v.source_time_us FROM records_event r
           JOIN record_versions v ON v.uri = r.uri ORDER BY r.rkey`,
        )
        .all<{ rkey: string; time_us: number; source_time_us: number }>()
    ).results;
    const batchOldestUs = createdUs - 86_400_000_000;
    expect(loaded).toEqual([
      { rkey: "early", time_us: createdUs - 5, source_time_us: batchOldestUs },
      { rkey: "old", time_us: batchOldestUs, source_time_us: batchOldestUs },
      { rkey: "seen", time_us: createdUs, source_time_us: batchOldestUs },
    ]);
  });

  it("continues an interrupted export after the last record it received", async () => {
    const resolved = config();
    const db = await freshDb(resolved);
    const { fetchImpl, requests } = service({ rows: ROWS, cutAfter: 3 });

    const result = await loadAlluviumExport(db, resolved, {
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: fetchImpl,
      now: () => NOW_MS,
      transport: { batchSize: 2, maxAttempts: 2 },
    });
    expect(result.recordsLoaded).toBe(5);

    const exports = requests.filter((url) => url.pathname === "/export");
    expect(exports).toHaveLength(2);
    expect(exports[0]!.searchParams.get("after")).toBeNull();
    expect(exports[1]!.searchParams.get("after")).toBe(uri(ROWS[2]!));
  });

  it("resumes from durable _contrail_meta progress after a restart", async () => {
    const resolved = config();
    const db = await freshDb(resolved);

    // First run fails after projecting the first batch of 2 records (maxAttempts: 1).
    const first = service({ rows: ROWS, cutAfter: 2 });
    await expect(
      loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        fetch: first.fetchImpl,
        now: () => NOW_MS,
        transport: { batchSize: 2, maxAttempts: 1 },
      }),
    ).rejects.toThrow("Alluvium export did not complete");

    expect(await getAlluviumBootstrapState(db)).toMatchObject({
      phase: "loading",
      after: uri(ROWS[1]!),
    });
    expect(await getLastCursor(db)).toBeNull();

    // Restarting continues from `?after=<uri>` and completes cleanly.
    const second = service({ rows: ROWS });
    const result = await loadAlluviumExport(db, resolved, {
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: second.fetchImpl,
      now: () => NOW_MS,
      transport: { batchSize: 2, maxAttempts: 2 },
    });
    expect(result.resumed).toBe(true);
    expect(result.alreadyComplete).toBe(false);
    expect(result.recordsLoaded).toBe(3);
    expect(
      second.requests.find((url) => url.pathname === "/export")!.searchParams.get("after"),
    ).toBe(uri(ROWS[1]!));
    expect((await queryRecords(db, resolved, { collection: EVENT })).records).toHaveLength(3);
    expect((await queryRecords(db, resolved, { collection: RSVP })).records).toHaveLength(2);
  });

  it("fails when the export keeps ending early", async () => {
    const resolved = config();
    const db = await freshDb(resolved);
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/alluvium/head") {
        return Response.json({ cursor: 1, time_us: HEAD_US, excludes: [] });
      }
      return new Response("", { headers: { "alluvium-time-us": String(HEAD_US) } });
    };
    await expect(
      loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        collections: [EVENT],
        fetch: fetchImpl,
        now: () => NOW_MS,
        transport: { maxAttempts: 2 },
      }),
    ).rejects.toThrow("Alluvium export did not complete");
  });

  it("fails at once when the end line disagrees with the records sent", async () => {
    const resolved = config();
    const db = await freshDb(resolved);
    const { fetchImpl, requests } = service({ rows: ROWS, miscount: 1 });
    await expect(
      loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        fetch: fetchImpl,
        now: () => NOW_MS,
        transport: { maxAttempts: 2 },
      }),
    ).rejects.toThrow("different record count");
    expect(requests.filter((url) => url.pathname === "/export")).toHaveLength(1);
  });

  it("rejects malformed and unrequested records without retrying", async () => {
    for (const text of [
      "not json",
      JSON.stringify({ uri: `at://${DID}/com.example.other/x`, cid: "c", time_us: 1, record: {} }),
      JSON.stringify({ uri: `at://nope/${EVENT}/x`, cid: "c", time_us: 1, record: {} }),
      JSON.stringify({ uri: `at://${DID}/${EVENT}/x/y`, cid: "c", time_us: 1, record: {} }),
      JSON.stringify({ uri: `at://${DID}/${EVENT}/x`, time_us: 1, record: {} }),
      JSON.stringify({ uri: `at://${DID}/${EVENT}/x`, cid: "c", record: {} }),
      JSON.stringify({ uri: `at://${DID}/${EVENT}/x`, cid: "c", time_us: 1, record: null }),
    ]) {
      const resolved = config();
      const db = await freshDb(resolved);
      const { fetchImpl, requests } = service({ rows: ROWS, corrupt: { at: 1, text } });
      await expect(
        loadAlluviumExport(db, resolved, {
          endpoint: ENDPOINT,
          source: SOURCE,
          collections: [EVENT],
          fetch: fetchImpl,
          now: () => NOW_MS,
          transport: { maxAttempts: 2 },
        }),
      ).rejects.toThrow(TypeError);
      expect(requests.filter((url) => url.pathname === "/export")).toHaveLength(1);
    }
  });

  it("refuses excluded collections, stale snapshots, heads without time, and plain HTTP", async () => {
    const resolved = config();
    const baseOpts = { endpoint: ENDPOINT, source: SOURCE, now: () => NOW_MS, transport: { maxAttempts: 1 } };

    await expect(
      loadAlluviumExport(await freshDb(resolved), resolved, {
        ...baseOpts,
        collections: [EVENT, "app.bsky.feed.post"],
        fetch: service({ rows: [] }).fetchImpl,
      }),
    ).rejects.toThrow("does not carry app.bsky.feed.post");

    await expect(
      loadAlluviumExport(await freshDb(resolved), resolved, {
        ...baseOpts,
        collections: [EVENT],
        fetch: service({
          rows: [],
          head: { cursor: 5, time_us: HEAD_US - 2 * 3_600_000_000, excludes: [] },
        }).fetchImpl,
      }),
    ).resolves.toBeDefined();

    await expect(
      loadAlluviumExport(await freshDb(resolved), resolved, {
        ...baseOpts,
        collections: [EVENT],
        fetch: service({
          rows: [],
          head: { cursor: 5, time_us: HEAD_US - 24 * 3_600_000_000, excludes: [] },
        }).fetchImpl,
      }),
    ).rejects.toThrow("serving a snapshot 1440 minutes old");

    await expect(
      loadAlluviumExport(await freshDb(resolved), resolved, {
        ...baseOpts,
        collections: [EVENT],
        fetch: service({ rows: [], head: { cursor: 5 } }).fetchImpl,
      }),
    ).rejects.toThrow("Alluvium head is unavailable: Alluvium head time_us must be");

    await expect(
      loadAlluviumExport(await freshDb(resolved), resolved, {
        endpoint: "http://alluvium.test",
        source: SOURCE,
        fetch: service({ rows: [] }).fetchImpl,
      }),
    ).rejects.toThrow("HTTPS");
  });

  it("reads only exports that reach the snapshot it pinned", async () => {
    const HOUR_US = 3_600_000_000;
    const resolved = config();

    const runWithExportTime = async (exportTimeUs: number | null) => {
      const db = await freshDb(resolved);
      const { fetchImpl } = service({ rows: ROWS, exportTimeUs });
      return loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        fetch: fetchImpl,
        now: () => NOW_MS,
        transport: { maxAttempts: 1 },
      });
    };

    await expect(runWithExportTime(HEAD_US - HOUR_US)).rejects.toThrow(
      "older than the snapshot this bootstrap pinned",
    );
    await expect(runWithExportTime(null)).rejects.toThrow(
      "did not say which snapshot it serves",
    );

    const newer = await runWithExportTime(HEAD_US + HOUR_US);
    expect(newer.recordsLoaded).toBe(ROWS.length);
    expect(newer.handoff).toEqual({
      source: SOURCE.id,
      epoch: SOURCE.epoch,
      cursor: String(HEAD_US - DEFAULT_ALLUVIUM_REWIND_US),
    });
  });

  it("refuses to resume a bootstrap whose replay window has passed", async () => {
    const resolved = config();
    const db = await freshDb(resolved);

    // Pause mid-load at NOW_MS.
    const interrupted = service({ rows: ROWS, cutAfter: 2 });
    await expect(
      loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        fetch: interrupted.fetchImpl,
        now: () => NOW_MS,
        transport: { batchSize: 2, maxAttempts: 1 },
      }),
    ).rejects.toThrow("Alluvium export did not complete");

    // Two days later, resuming refuses immediately without calling /export.
    const late = service({ rows: ROWS });
    await expect(
      loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        fetch: late.fetchImpl,
        now: () => NOW_MS + 48 * 3_600_000,
      }),
    ).rejects.toThrow(SourceHistoryExpiredError);
    expect(late.requests).toHaveLength(0);

    // Twelve hours on, the same bootstrap still resumes cleanly.
    const soon = service({ rows: ROWS });
    const resumed = await loadAlluviumExport(db, resolved, {
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: soon.fetchImpl,
      now: () => NOW_MS + 12 * 3_600_000,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.recordsLoaded).toBe(3);
  });

  it("refuses to overwrite a non-empty database without bootstrap state", async () => {
    const resolved = config();
    const db = await freshDb(resolved);
    await saveJetstreamCursor(db, 12345);
    await expect(
      loadAlluviumExport(db, resolved, {
        endpoint: ENDPOINT,
        source: SOURCE,
        fetch: service({ rows: ROWS }).fetchImpl,
        now: () => NOW_MS,
      }),
    ).rejects.toThrow("fresh unpublished database");
    expect(await db.prepare("SELECT value FROM _contrail_meta WHERE key = ?").bind(ALLUVIUM_BOOTSTRAP_META_KEY).first()).toBeNull();
  });

  it("drops secondary indexes during the load and restores exactly them", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    const indexes = async () =>
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
          )
          .all<{ name: string }>()
      ).results.map((row) => row.name);
    const { fetchImpl } = service({
      rows: ROWS,
      head: { cursor: 1_000, time_us: Date.now() * 1_000, excludes: [] },
    });
    let duringLoad: string[] | null = null;
    const watching: typeof fetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (new URL(String(input)).pathname === "/export") duringLoad = await indexes();
      return response;
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = watching;
    let before: string[];
    try {
      await new Contrail(resolved).init(db);
      before = await indexes();
      await bootstrapAlluviumDatabase({ config: resolved, db, endpoint: ENDPOINT, deferIndexes: true });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(before.some((name) => name.startsWith("idx_event_"))).toBe(true);
    expect(duringLoad!.some((name) => name.startsWith("idx_event_"))).toBe(false);
    expect(await indexes()).toEqual(before);
    const meta = await db
      .prepare("SELECT value FROM _contrail_meta WHERE key = 'bootstrap_deferred_indexes'")
      .first();
    expect(meta).toBeNull();
    const events = await queryRecords(db, resolved, { collection: EVENT });
    expect(events.records).toHaveLength(3);
  });

  it("loads a fresh database and leaves live ingestion a timestamp cursor", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    const recentUs = Date.now() * 1_000 - 5_000_000;
    const oldUs = recentUs - 300 * 86_400_000_000;
    const { fetchImpl } = service({
      rows: ROWS.map((row) => ({ ...row, timeUs: row.rkey === "r1" ? oldUs : recentUs })),
      head: { cursor: 1_000, time_us: Date.now() * 1_000, excludes: ["app.bsky.*"] },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    let result;
    try {
      result = await bootstrapAlluviumDatabase({ config: resolved, db, endpoint: ENDPOINT });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(result.resumed).toBe(false);
    expect(result.handoff.source).toBe(SOURCE.id);
    expect(result.handoff.epoch).toBe(SOURCE.epoch);
    expect(result.liveCursor).toBe(Number(result.handoff.cursor));
    expect(result.liveCursor).toBeGreaterThan(1_000_000_000_000_000);
    expect(await getLastCursor(db)).toBe(result.liveCursor);
    expect((await getServingSourcePosition(db))?.position).toEqual(result.handoff);

    const events = await queryRecords(db, resolved, { collection: EVENT });
    expect(events.records.map((record) => record.rkey).sort()).toEqual(["e1", "e2", "e3"]);
    const rsvps = await queryRecords(db, resolved, { collection: RSVP });
    expect(rsvps.records).toHaveLength(2);
    expect(
      Object.fromEntries(rsvps.records.map((record) => [record.rkey, Number(record.time_us)])),
    ).toEqual({
      r1: oldUs,
      r2: recentUs,
    });

    // Running it again on the loaded database loads nothing.
    const { fetchImpl: unused, requests } = service({ rows: ROWS });
    globalThis.fetch = unused;
    try {
      const again = await bootstrapAlluviumDatabase({ config: resolved, db, endpoint: ENDPOINT });
      expect(again).toMatchObject({
        resumed: true,
        alreadyComplete: true,
        liveCursor: result.liveCursor,
      });

      // Live ingestion takes over the cursor and replaces the timestamp with a
      // sequence number; re-running must still succeed and leave it alone.
      await saveJetstreamCursor(db, 57_624_562);
      const later = await bootstrapAlluviumDatabase({ config: resolved, db, endpoint: ENDPOINT });
      expect(later).toMatchObject({ alreadyComplete: true, liveCursor: 57_624_562 });
      expect(await getLastCursor(db)).toBe(57_624_562);
      expect(requests).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
