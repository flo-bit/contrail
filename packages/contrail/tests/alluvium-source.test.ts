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

function line(row: Row, index: number): string {
  return JSON.stringify({
    // The service splices the token in first; field order is not relied on.
    resume: `token-${index}`,
    did: DID,
    cursor: 100 + index,
    time_us: row.timeUs ?? HEAD_US - 1_000_000 + index,
    kind: "commit",
    commit: {
      operation: "create",
      collection: row.collection,
      rkey: row.rkey,
      rev: "3kabcdefghij2",
      cid: `bafy-${row.rkey}`,
      record: { $type: row.collection, name: row.name },
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
}

/** A fetch that behaves like the service's /collections and /export. */
function service(options: ServiceOptions) {
  const requests: URL[] = [];
  let exports = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/collections") {
      return Response.json(
        options.head ?? {
          cursor: 1_000,
          time_us: HEAD_US,
          excludes: ["app.bsky.*", "chat.bsky.*"],
          collections: [],
        },
      );
    }
    if (url.pathname !== "/export") return new Response("not found", { status: 404 });
    exports += 1;
    const wanted = new Set(url.searchParams.getAll("collection"));
    const after = url.searchParams.get("after");
    const start = after ? Number(after.replace("token-", "")) + 1 : 0;
    const selected = options.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => index >= start && wanted.has(row.collection));
    let lines = selected.map(({ row, index }) => line(row, index));
    if (options.corrupt) lines[options.corrupt.at] = options.corrupt.text;
    const cut = exports === 1 && options.cutAfter !== undefined;
    if (cut) lines = lines.slice(0, options.cutAfter);
    else lines.push(JSON.stringify({ kind: "end", cursor: 1_000, time_us: HEAD_US, records: selected.length }));
    return new Response(lines.map((text) => `${text}\n`).join(""), {
      headers: { "content-type": "application/x-ndjson" },
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

function sources(fetchImpl: typeof fetch, transport = {}) {
  return createAlluviumBootstrapSources(config(), {
    endpoint: ENDPOINT,
    source: SOURCE,
    fetch: fetchImpl,
    now: () => NOW_MS,
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
      { partition: "export", cursor: "token-1", complete: false },
      { partition: "export", cursor: "token-3", complete: false },
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
    expect(exportRequest.searchParams.get("resume")).toBe("1");

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
    expect(exports[1]!.searchParams.get("after")).toBe("token-2");
  });

  it("resumes from durable progress after a restart", async () => {
    const { fetchImpl, requests } = service({ rows: ROWS });
    const source = sources(fetchImpl);
    const snapshot = await source.snapshotSource.prepare({ collections: [EVENT, RSVP] });

    const batches = await collect(
      source.snapshotSource.read({
        snapshot,
        progress: [{ partition: "export", cursor: "token-2", complete: false }],
      }),
    );
    expect(batches.flatMap((batch) => batch.records).map((record) => record.rkey)).toEqual(["r1", "r2"]);
    expect(requests.find((url) => url.pathname === "/export")!.searchParams.get("after")).toBe("token-2");

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
      if (url.pathname === "/collections") {
        return Response.json({ cursor: 1, time_us: HEAD_US, excludes: [], collections: [] });
      }
      return new Response("");
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
      JSON.stringify({ kind: "commit", did: DID, time_us: 1, resume: "t", commit: { operation: "create", collection: "com.example.other", rkey: "x", cid: "c", record: {} } }),
      JSON.stringify({ kind: "commit", did: "nope", time_us: 1, resume: "t", commit: { operation: "create", collection: EVENT, rkey: "x", cid: "c", record: {} } }),
      JSON.stringify({ kind: "commit", did: DID, time_us: 1, commit: { operation: "create", collection: EVENT, rkey: "x", cid: "c", record: {} } }),
    ]) {
      const { fetchImpl, requests } = service({ rows: ROWS, corrupt: { at: 1, text } });
      const source = sources(fetchImpl);
      const snapshot = await source.snapshotSource.prepare({ collections: [EVENT] });
      await expect(collect(source.snapshotSource.read({ snapshot }))).rejects.toThrow(TypeError);
      expect(requests.filter((url) => url.pathname === "/export")).toHaveLength(1);
    }
  });

  it("refuses collections the service does not carry, a lagging service, and an old one", async () => {
    const carried = sources(service({ rows: [] }).fetchImpl);
    await expect(
      carried.snapshotSource.prepare({ collections: [EVENT, "app.bsky.feed.post"] }),
    ).rejects.toThrow("does not carry app.bsky.feed.post");

    const lagging = sources(
      service({
        rows: [],
        head: { cursor: 5, time_us: HEAD_US - 3_600_000_000, excludes: [], collections: [] },
      }).fetchImpl,
    );
    await expect(lagging.snapshotSource.prepare({ collections: [EVENT] })).rejects.toThrow(
      "60 minutes behind the firehose",
    );

    const old = sources(service({ rows: [], head: { cursor: 5, collections: [] } }).fetchImpl);
    await expect(old.snapshotSource.prepare({ collections: [EVENT] })).rejects.toThrow(
      "Alluvium head is unavailable",
    );

    expect(() =>
      createAlluviumBootstrapSources(config(), { endpoint: "http://alluvium.test", source: SOURCE }),
    ).toThrow("HTTPS");
  });

  it("loads a fresh database and leaves live ingestion a timestamp cursor", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    const { fetchImpl } = service({
      rows: ROWS.map((row) => ({ ...row, timeUs: Date.now() * 1_000 - 5_000_000 })),
      // The real clock decides lag here, so report a current head.
      head: { cursor: 1_000, time_us: Date.now() * 1_000, excludes: ["app.bsky.*"], collections: [] },
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

    // A populated database is not a fresh generation.
    globalThis.fetch = fetchImpl;
    try {
      const again = await bootstrapAlluviumDatabase({ config: resolved, db, endpoint: ENDPOINT });
      expect(again.resumed).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
