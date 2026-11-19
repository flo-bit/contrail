import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLUVIUM_REWIND_US,
  createAlluviumBootstrapSources,
  createAlluviumLiveCursor,
} from "../src/adapters/alluvium";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import {
  getLastCursor,
  getServingSourcePosition,
  queryRecords,
  resolveConfig,
} from "../src/index";
import { saveJetstreamCursor } from "../src/core/db/records";
import { SourceHistoryExpiredError } from "../src/core/jetstream-source";
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
    record: { $type: row.collection, name: row.name },
  });
}

interface ServiceOptions {
  rows: Row[];
  head?: Record<string, unknown>;
  /** Cut the first export response after this many lines, with no end line. */
  cutAfter?: number;
  /** Replace export line N (0-based, within a response) with raw text. */
  corrupt?: { at: number; text: string };
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
    // The rows are listed in export order; resume just past the one named.
    const start = after ? options.rows.findIndex((row) => uri(row) === after) + 1 : 0;
    const selected = options.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => index >= start && wanted.has(row.collection));
    let lines = selected.map(({ row, index }) => line(row, index));
    if (options.corrupt) lines[options.corrupt.at] = options.corrupt.text;
    const cut = exports === 1 && options.cutAfter !== undefined;
    if (cut) lines = lines.slice(0, options.cutAfter);
    else lines.push(JSON.stringify({ end: true, cursor: 1_000, time_us: HEAD_US, records: selected.length }));
    const headTimeUs = typeof options.head?.time_us === "number" ? options.head.time_us : HEAD_US;
    const servedUs = options.exportTimeUs === undefined ? headTimeUs : options.exportTimeUs;
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
    ...(orderedSource ? { orderedSource: { source: SOURCE.id, epoch: SOURCE.epoch } } : {}),
    collections: {
      event: { collection: EVENT },
      rsvp: { collection: RSVP },
    },
  });
}

function sources(fetchImpl: typeof fetch, transport = {}, nowMs = NOW_MS) {
  return createAlluviumBootstrapSources(config(), {
    endpoint: ENDPOINT,
    source: SOURCE,
    fetch: fetchImpl,
    now: () => nowMs,
    transport: { batchSize: 2, maxAttempts: 2, ...transport },
  });
}

const ROWS: Row[] = [
  { collection: EVENT, rkey: "e1", name: "one" },
  { collection: EVENT, rkey: "e2", name: "two" },
  { collection: EVENT, rkey: "e3", name: "three" },
  { collection: RSVP, rkey: "r1", name: "yes", timeUs: OLD_US },
  { collection: RSVP, rkey: "r2", name: "no" },
];

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("Alluvium bootstrap source", () => {
  it("pins the head, streams the export in resumable batches, and hands off by time", async () => {
    const { fetchImpl, requests } = service({ rows: ROWS });
    const source = sources(fetchImpl);

    const captureFrom = await source.changeSource.mark({ collections: [EVENT, RSVP] });
    const snapshot = await source.snapshotSource.prepare({ collections: [RSVP, EVENT] });
    expect(snapshot.through).toBeUndefined();
    expect(snapshot.collections).toEqual({
      [EVENT]: { state: "complete" },
      [RSVP]: { state: "complete" },
    });

    const batches = await collect(source.snapshotSource.read({ snapshot }));
    expect(batches.flatMap((batch) => batch.records).map((record) => record.rkey)).toEqual([
      "e1", "e2", "e3", "r1", "r2",
    ]);
    expect(batches.map((batch) => batch.progress)).toEqual([
      { partition: "export", cursor: uri(ROWS[1]!), complete: false },
      { partition: "export", cursor: uri(ROWS[3]!), complete: false },
      { partition: "export", cursor: null, complete: true },
    ]);
    expect(batches.map((batch) => batch.done)).toEqual([false, false, true]);
    expect(batches[0]!.records[0]).toEqual({
      uri: `at://${DID}/${EVENT}/e1`,
      did: DID,
      collection: EVENT,
      rkey: "e1",
      cid: "bafy-e1",
      value: { $type: EVENT, name: "one" },
    });
    // A batch is ordered against later changes by one time. It is never
    // later than the live cursor, so everything the live replay delivers
    // applies on top, and never later than the batch's oldest record.
    expect(batches[0]!.sourceTimeUs).toBe(HEAD_US - DEFAULT_ALLUVIUM_REWIND_US);
    expect(batches[1]!.sourceTimeUs).toBe(OLD_US);

    const exportRequest = requests.find((url) => url.pathname === "/export")!;
    expect(exportRequest.searchParams.getAll("collection")).toEqual([EVENT, RSVP]);

    // Live ingestion resumes a rewind before the pinned head, on a time
    // cursor, and the capture mark sits strictly before it.
    const through = await source.changeSource.mark({ collections: [EVENT, RSVP], snapshot });
    const liveCursorUs = HEAD_US - DEFAULT_ALLUVIUM_REWIND_US;
    expect(through).toEqual({ source: SOURCE.id, epoch: SOURCE.epoch, cursor: String(liveCursorUs) });
    expect(Number(captureFrom.cursor)).toBe(liveCursorUs - 1);
    expect(createAlluviumLiveCursor(SOURCE)(through)).toBe(liveCursorUs);

    // Nothing is replayed: the export already holds every change.
    expect(
      await collect(
        source.changeSource.read({ collections: [EVENT, RSVP], snapshot, after: captureFrom, through }),
      ),
    ).toEqual([{ mutations: [], checkpoint: through, caughtUp: true }]);
  });

  it("continues an interrupted export after the last record it received", async () => {
    const { fetchImpl, requests } = service({ rows: ROWS, cutAfter: 3 });
    const source = sources(fetchImpl);
    const snapshot = await source.snapshotSource.prepare({ collections: [EVENT, RSVP] });

    const batches = await collect(source.snapshotSource.read({ snapshot }));
    expect(batches.flatMap((batch) => batch.records).map((record) => record.rkey)).toEqual([
      "e1", "e2", "e3", "r1", "r2",
    ]);
    expect(batches.at(-1)).toMatchObject({ done: true });

    const exports = requests.filter((url) => url.pathname === "/export");
    expect(exports).toHaveLength(2);
    expect(exports[0]!.searchParams.get("after")).toBeNull();
    expect(exports[1]!.searchParams.get("after")).toBe(uri(ROWS[2]!));
  });

  it("resumes from durable progress after a restart", async () => {
    const { fetchImpl, requests } = service({ rows: ROWS });
    const source = sources(fetchImpl);
    const snapshot = await source.snapshotSource.prepare({ collections: [EVENT, RSVP] });

    const batches = await collect(
      source.snapshotSource.read({
        snapshot,
        progress: [{ partition: "export", cursor: uri(ROWS[2]!), complete: false }],
      }),
    );
    expect(batches.flatMap((batch) => batch.records).map((record) => record.rkey)).toEqual(["r1", "r2"]);
    expect(requests.find((url) => url.pathname === "/export")!.searchParams.get("after")).toBe(uri(ROWS[2]!));

    // A completed export reads nothing more.
    expect(
      await collect(
        source.snapshotSource.read({
          snapshot,
          progress: [{ partition: "export", cursor: null, complete: true }],
        }),
      ),
    ).toEqual([]);
  });

  it("fails when the export keeps ending early", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/alluvium/head") {
        return Response.json({ cursor: 1, time_us: HEAD_US, excludes: [] });
      }
      return new Response("", { headers: { "alluvium-time-us": String(HEAD_US) } });
    };
    const source = sources(fetchImpl);
    const snapshot = await source.snapshotSource.prepare({ collections: [EVENT] });
    await expect(collect(source.snapshotSource.read({ snapshot }))).rejects.toThrow(
      "Alluvium export did not complete",
    );
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
      const { fetchImpl, requests } = service({ rows: ROWS, corrupt: { at: 1, text } });
      const source = sources(fetchImpl);
      const snapshot = await source.snapshotSource.prepare({ collections: [EVENT] });
      await expect(collect(source.snapshotSource.read({ snapshot }))).rejects.toThrow(TypeError);
      expect(requests.filter((url) => url.pathname === "/export")).toHaveLength(1);
    }
  });

  it("refuses collections the service does not carry, a stale snapshot, and a head without a time", async () => {
    const carried = sources(service({ rows: [] }).fetchImpl);
    await expect(
      carried.snapshotSource.prepare({ collections: [EVENT, "app.bsky.feed.post"] }),
    ).rejects.toThrow("does not carry app.bsky.feed.post");

    // An hourly snapshot is a few hours old at most; a day-old one is not.
    const recent = sources(
      service({ rows: [], head: { cursor: 5, time_us: HEAD_US - 2 * 3_600_000_000, excludes: [] } }).fetchImpl,
    );
    await expect(recent.snapshotSource.prepare({ collections: [EVENT] })).resolves.toBeDefined();
    const stale = sources(
      service({ rows: [], head: { cursor: 5, time_us: HEAD_US - 24 * 3_600_000_000, excludes: [] } }).fetchImpl,
    );
    await expect(stale.snapshotSource.prepare({ collections: [EVENT] })).rejects.toThrow(
      "serving a snapshot 1440 minutes old",
    );

    const old = sources(service({ rows: [], head: { cursor: 5 } }).fetchImpl);
    await expect(old.snapshotSource.prepare({ collections: [EVENT] })).rejects.toThrow(
      "Alluvium head is unavailable",
    );

    expect(() =>
      createAlluviumBootstrapSources(config(), { endpoint: "http://alluvium.test", source: SOURCE }),
    ).toThrow("HTTPS");
  });

  it("reads only exports that reach the snapshot it pinned", async () => {
    const HOUR_US = 3_600_000_000;
    const pin = async (options: Partial<ServiceOptions>) => {
      const served = service({ rows: ROWS, ...options });
      // Pin against the head; /export then answers for another snapshot.
      const source = sources(served.fetchImpl, { maxAttempts: 1 });
      const snapshot = await source.snapshotSource.prepare({ collections: [EVENT, RSVP] });
      return { source, snapshot, requests: served.requests };
    };

    // A rollback or a replica that is behind: the live replay would start
    // after changes this export does not hold. Nothing is projected.
    const older = await pin({ exportTimeUs: HEAD_US - HOUR_US });
    await expect(collect(older.source.snapshotSource.read({ snapshot: older.snapshot }))).rejects.toThrow(
      "older than the snapshot this bootstrap pinned",
    );
    const unnamed = await pin({ exportTimeUs: null });
    await expect(collect(unnamed.source.snapshotSource.read({ snapshot: unnamed.snapshot }))).rejects.toThrow(
      "did not say which snapshot it serves",
    );

    // A newer snapshot, as after a resume across an hourly build, is read,
    // and the handoff stays where it was pinned.
    const newer = await pin({ exportTimeUs: HEAD_US + HOUR_US });
    const batches = await collect(newer.source.snapshotSource.read({ snapshot: newer.snapshot }));
    expect(batches.flatMap((batch) => batch.records)).toHaveLength(ROWS.length);
    expect(
      await newer.source.changeSource.mark({ collections: [EVENT, RSVP], snapshot: newer.snapshot }),
    ).toEqual({
      source: SOURCE.id,
      epoch: SOURCE.epoch,
      cursor: String(HEAD_US - DEFAULT_ALLUVIUM_REWIND_US),
    });
  });

  it("refuses to finish a bootstrap whose replay window has passed", async () => {
    const { fetchImpl, requests } = service({ rows: ROWS });
    const snapshot = await sources(fetchImpl).snapshotSource.prepare({ collections: [EVENT, RSVP] });
    const progress = [{ partition: "export", cursor: uri(ROWS[2]!), complete: false }];
    const position = { source: SOURCE.id, epoch: SOURCE.epoch };
    const after = { ...position, cursor: String(HEAD_US - DEFAULT_ALLUVIUM_REWIND_US - 1) };
    const through = { ...position, cursor: String(HEAD_US - DEFAULT_ALLUVIUM_REWIND_US) };

    // Twelve hours on, the same bootstrap still resumes.
    const soon = sources(fetchImpl, {}, NOW_MS + 12 * 3_600_000);
    expect(await collect(soon.snapshotSource.read({ snapshot, progress }))).not.toHaveLength(0);

    // Two days on, live ingestion could no longer replay from its cursor:
    // whether the export was half read or fully read, it does not complete.
    const late = sources(fetchImpl, {}, NOW_MS + 48 * 3_600_000);
    const before = requests.length;
    await expect(collect(late.snapshotSource.read({ snapshot, progress }))).rejects.toThrow(
      SourceHistoryExpiredError,
    );
    await expect(
      late.changeSource.mark({ collections: [EVENT, RSVP], snapshot }),
    ).rejects.toThrow("Start again with a fresh database");
    await expect(
      collect(late.changeSource.read({ collections: [EVENT, RSVP], snapshot, after, through })),
    ).rejects.toThrow(SourceHistoryExpiredError);
    expect(requests).toHaveLength(before);
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
    // Watch the index set while records are being written.
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
      // Create the schema first so the full index set is known.
      const { Contrail } = await import("../src/index");
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
    const { fetchImpl } = service({
      rows: ROWS.map((row) => ({ ...row, timeUs: Date.now() * 1_000 - 5_000_000 })),
      // The real clock decides lag here, so report a current head.
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

    // Running it again on the loaded database loads nothing.
    const { fetchImpl: unused, requests } = service({ rows: ROWS });
    globalThis.fetch = unused;
    try {
      const again = await bootstrapAlluviumDatabase({ config: resolved, db, endpoint: ENDPOINT });
      expect(again).toMatchObject({ resumed: true, alreadyComplete: true, liveCursor: result.liveCursor });

      // Live ingestion then takes the cursor over and replaces the timestamp
      // with a sequence number. `contrail dev --alluvium` runs the bootstrap
      // on every start, so it must still pass, and leave the cursor alone.
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
