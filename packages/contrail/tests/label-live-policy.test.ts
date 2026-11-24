import { encode } from "@atcute/cbor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  runLabelIngestCycle,
  type Database,
} from "../src/index";

const src = "did:plc:external";
const did = "did:plc:test";
const label = { src, uri: did, val: "!hide", cts: "2026-01-01T00:00:00Z" };

class LabelSocket extends EventTarget {
  static instances: LabelSocket[] = [];
  binaryType = "arraybuffer";
  closed = false;
  constructor(readonly url: string) {
    super();
    LabelSocket.instances.push(this);
  }
  frame(payload: object, type = "#labels") {
    const header = encode({ op: 1, t: type });
    const body = encode(payload);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);
    this.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}

function policy(values: string[]) {
  return resolveConfig({
    ...TEST_CONFIG,
    profiles: [],
    logger: { log() {}, warn() {}, error() {} },
    labels: { sources: [{ did: src, endpoint: "https://labels.example", enforce: true, values }] },
  });
}

async function setup() {
  LabelSocket.instances = [];
  vi.stubGlobal("WebSocket", LabelSocket);
  const db = createTestDb();
  const config = policy(["!hide"]);
  await initSchema(db, config);
  await ingestRecords(db, [makeEvent()], config);
  await db.prepare("INSERT INTO labeler_cursors (did, cursor, endpoint, resolved_at) VALUES (?, 10, ?, ?)")
    .bind(src, "https://labels.example", Date.now()).run();
  return { db, config };
}

async function socket() {
  await vi.waitFor(() => expect(LabelSocket.instances).toHaveLength(1));
  return LabelSocket.instances[0]!;
}

async function cursor(db: Database) {
  return Number((await db.prepare("SELECT cursor FROM labeler_cursors WHERE did = ?").bind(src).first<any>())?.cursor);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scheduled label ingestion", () => {
  it("pumps every external source each cycle and resumes cursor-only checkpoints", async () => {
    const { db, config: initial } = await setup();
    const second = "did:plc:second";
    const config = resolveConfig({
      ...initial,
      moderation: { moderators: ["did:plc:moderator"], reports: false },
      labels: { sources: [
        ...initial.labels!.sources,
        { did: second, endpoint: "https://second.example", enforce: true },
      ] },
    });
    await initSchema(db, config);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

    for (let cycle = 0; cycle < 2; cycle++) {
      const work = runLabelIngestCycle(db, config, 25_000);
      await vi.waitFor(() => expect(LabelSocket.instances).toHaveLength((cycle + 1) * 2));
      const sockets = LabelSocket.instances.slice(cycle * 2);
      expect(sockets.map((ws) => new URL(ws.url).hostname)).toEqual(["labels.example", "second.example"]);
      if (cycle) {
        expect(sockets.map((ws) => new URL(ws.url).searchParams.get("cursor"))).toEqual(["11", "11"]);
      }
      sockets.forEach((ws, index) => ws.frame({
        seq: 11 + cycle,
        labels: [{ ...label, src: index ? second : src }],
      }));
      // Neither server closes after catching up; both must get the deadline.
      await vi.advanceTimersByTimeAsync(25_000);
      await work;
      expect(sockets.every((ws) => ws.closed)).toBe(true);
    }

    expect(await cursor(db)).toBe(12);
    expect(Number((await db.prepare("SELECT cursor FROM labeler_cursors WHERE did = ?").bind(second).first<any>())?.cursor)).toBe(12);
    expect((await db.prepare("SELECT DISTINCT src FROM labels ORDER BY src").all()).results)
      .toEqual([{ src }, { src: second }]);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("does not let one failed source prevent another from ingesting", async () => {
    const { db, config: initial } = await setup();
    const config = resolveConfig({ ...initial, labels: { sources: [
      ...initial.labels!.sources,
      { did: "did:plc:second", endpoint: "https://second.example", enforce: true },
    ] } });
    await initSchema(db, config);
    const work = runLabelIngestCycle(db, config, 1_000);
    await vi.waitFor(() => expect(LabelSocket.instances).toHaveLength(2));
    LabelSocket.instances[0]!.dispatchEvent(new Event("error"));
    const ws = LabelSocket.instances[1]!;
    ws.frame({ seq: 11, labels: [{ ...label, src: "did:plc:second" }] });
    ws.close();
    await work;
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
    expect(await cursor(db)).toBe(10);
  });

  it("does not skip a quiet backfill:false labeler's labels issued between cycles", async () => {
    LabelSocket.instances = [];
    vi.stubGlobal("WebSocket", LabelSocket);
    const db = createTestDb();
    const config = resolveConfig({
      ...policy(["!hide"]),
      labels: { sources: [{ did: src, endpoint: "https://labels.example", enforce: true, backfill: false }] },
    });
    await initSchema(db, config);
    await ingestRecords(db, [makeEvent()], config);

    // First cycle follows from now and sees no frame, so no cursor exists.
    let work = runLabelIngestCycle(db, config, 1_000);
    let ws = await socket();
    expect(new URL(ws.url).searchParams.has("cursor")).toBe(false);
    ws.close();
    await work;
    const startedAt = Date.now();

    // Next cycle replays, dropping history from before the first connection.
    LabelSocket.instances = [];
    work = runLabelIngestCycle(db, config, 1_000);
    ws = await socket();
    expect(new URL(ws.url).searchParams.get("cursor")).toBe("0");
    const old = new Date(startedAt - 60 * 60_000).toISOString();
    ws.frame({ seq: 1, labels: [{ ...label, uri: "did:plc:old", cts: old }] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(1);
    expect((await db.prepare("SELECT * FROM labels").all()).results).toEqual([]);

    // Replay may span multiple cycles. A nonzero cursor does not mean it has
    // caught up: old hides must still be dropped after reconnecting.
    LabelSocket.instances = [];
    work = runLabelIngestCycle(db, config, 1_000);
    ws = await socket();
    expect(new URL(ws.url).searchParams.get("cursor")).toBe("1");
    ws.frame({ seq: 2, labels: [{ ...label, cts: old }] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(2);
    expect((await db.prepare("SELECT * FROM labels").all()).results).toEqual([]);
    expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(1);

    // A later cycle still admits labels issued after the first connection.
    LabelSocket.instances = [];
    work = runLabelIngestCycle(db, config, 1_000);
    ws = await socket();
    expect(new URL(ws.url).searchParams.get("cursor")).toBe("2");
    ws.frame({ seq: 3, labels: [{ ...label, cts: new Date(startedAt + 1_000).toISOString() }] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(3);
    expect((await db.prepare("SELECT uri FROM labels").all()).results).toEqual([{ uri: did }]);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("resumes an existing backfill:false cursor without inventing a live cutoff", async () => {
    const { db, config: initial } = await setup();
    const config = resolveConfig({ ...initial, labels: { sources: [
      { ...initial.labels!.sources[0]!, backfill: false },
    ] } });
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    expect(new URL(ws.url).searchParams.get("cursor")).toBe("10");
    ws.frame({ seq: 11, labels: [label] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(11);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
    expect(await db.prepare("SELECT 1 FROM _contrail_meta WHERE key = ?")
      .bind(`labeler_live_since:${src}`).first()).toBeNull();
  });

  it("ignores a saved live cutoff when historical backfill is enabled", async () => {
    const { db, config } = await setup();
    await db.prepare("INSERT INTO _contrail_meta (key, value) VALUES (?, ?)")
      .bind(`labeler_live_since:${src}`, String(Date.now())).run();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    expect(new URL(ws.url).searchParams.get("cursor")).toBe("10");
    ws.frame({ seq: 11, labels: [label] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(11);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("commits labels, visibility and the source cursor", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(11);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("checkpoints filter-only frames", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [{ ...label, val: "spam" }] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(11);
    expect((await db.prepare("SELECT * FROM labels").all()).results).toEqual([]);
  });

  it("resets the current cursor without a close-time flush restoring the old sequence", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    ws.frame({ name: "OutdatedCursor" }, "#info");
    await work;
    expect(await cursor(db)).toBe(0);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });
});
