import { describe, expect, it, vi } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  applyLabels,
  hydrateLabels,
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  queryRecords,
  resolveConfig,
  type Database,
} from "../src/index";
import { reconcileModeratorActions } from "../src/core/moderation-sync";

const moderator = "did:plc:moderator";
const actor = "did:plc:test";
const external = "did:plc:external";
const config = resolveConfig({
  ...TEST_CONFIG,
  moderation: { moderators: [moderator], reports: false },
  labels: { sources: [{ did: external, enforce: true }] },
  logger: { log() {}, warn() {}, error() {} },
});
const cursorKey = `moderation_reconcile_cursor:${moderator}`;
const remote = (rkey: string, subject = actor) => ({
  uri: `at://${moderator}/${MODERATION_ACTION_NSID}/${rkey}`,
  cid: `cid-${rkey}`,
  value: { subject, action: "!hide", createdAt: "2026-01-01T00:00:00Z" },
});
const action = (rkey: string, value: Record<string, unknown>) => makeEvent({
  ...remote(rkey), did: moderator, collection: MODERATION_ACTION_NSID, rkey,
  record: { createdAt: "2026-01-01T00:00:00Z", ...value },
});
async function setup() {
  const db = createTestDb();
  await initSchema(db, config);
  await ingestRecords(db, [makeEvent()], config);
  return db;
}
async function setupReconcile() {
  const db = await setup();
  await db.prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
    .bind(moderator, "moderator.example", "https://pds.example", Date.now()).run();
  return db;
}
async function savedCursor(db: Database) {
  return (await db.prepare("SELECT value FROM _contrail_meta WHERE key = ?")
    .bind(cursorKey).first<{ value: string }>())?.value;
}
async function actions(db: Database) {
  return (await db.prepare("SELECT uri FROM moderation_actions ORDER BY uri").all<{ uri: string }>())
    .results.map((r) => r.uri);
}

describe("moderation timestamp precision", () => {
  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("honors the latest same-second assertion (latestNeg=%s, reverse=%s)", async (latestNeg, reverse) => {
    const db = await setup();
    const labels = [
      { src: external, uri: actor, val: "!hide", neg: !latestNeg, cts: "2026-01-01T00:00:00.100Z" },
      { src: external, uri: actor, val: "!hide", neg: latestNeg, cts: "2026-01-01T00:00:00.900Z" },
    ];
    if (reverse) labels.reverse();
    for (const label of labels) await applyLabels(db, [label], { config, source: config.labels!.sources[0] });
    expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(latestNeg ? 1 : 0);
    const hydrated = await hydrateLabels(db, [actor], [external]);
    if (latestNeg) expect(hydrated).toEqual({});
    else expect(hydrated[actor]![0]!.cts).toBe("2026-01-01T00:00:00.900Z");
  });

  it("compares overrides and external labels within the same second", async () => {
    const db = await setup();
    const label = { src: external, uri: actor, val: "!hide", cts: "2026-01-01T00:00:00.100Z" };
    await applyLabels(db, [label], { config });
    await ingestRecords(db, [action("override", {
      subject: actor, action: "override", createdAt: "2026-01-01T00:00:00.500Z",
    })], config);
    expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(1);
    expect(await hydrateLabels(db, [actor], [external])).toEqual({});
    await applyLabels(db, [{ ...label, cts: "2026-01-01T00:00:00.900Z" }], { config });
    expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(0);
    expect((await hydrateLabels(db, [actor], [external]))[actor]![0]!.cts).toBe("2026-01-01T00:00:00.900Z");
  });

  it("upgrades legacy seconds once, atomically, before policy maintenance", async () => {
    const db = await setup();
    await applyLabels(db, [{ src: external, uri: actor, val: "!hide", cts: "2026-01-01T00:00:00Z", exp: "2999-01-01T00:00:00Z" }], { config });
    await ingestRecords(db, [
      action("hide", { subject: actor, action: "!hide", expiresAt: "2999-01-01T00:00:00Z" }),
      action("override", { subject: actor, action: "override", createdAt: "2026-01-01T00:00:01Z" }),
    ], config);
    const tables = ["labels", "moderation_actions", "moderation_overrides"];
    const original = await Promise.all(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
    const hidden = await db.prepare("SELECT * FROM moderation_hidden").all();
    await db.batch([
      ...tables.map((table) => db.prepare(`UPDATE ${table} SET cts = cts / 1000`)),
      db.prepare("DELETE FROM _contrail_meta WHERE key IN ('moderation_cts_unit', 'schema_fingerprint')"),
    ]);
    const broken: Database = {
      dialect: db.dialect,
      prepare: (sql) => db.prepare(sql),
      batch: (stmts) => db.batch([...stmts, db.prepare("INSERT INTO __fail_migration VALUES (1)")]),
    };
    await expect(initSchema(broken, config)).rejects.toThrow();
    expect(await db.prepare("SELECT value FROM _contrail_meta WHERE key = 'moderation_cts_unit'").first()).toBeNull();
    expect(await db.prepare("SELECT cts FROM labels").first()).toEqual({ cts: Date.parse("2026-01-01T00:00:00Z") / 1000 });
    await Promise.all([initSchema(db, config), initSchema(db, config)]);
    await db.prepare("DELETE FROM _contrail_meta WHERE key = 'schema_fingerprint'").run();
    await initSchema(db, config);
    expect(await Promise.all(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()))).toEqual(original);
    expect(await db.prepare("SELECT * FROM moderation_hidden").all()).toEqual(hidden);
    expect((await hydrateLabels(db, [actor], [moderator]))[actor]![0]!.cts).toBe("2026-01-01T00:00:00.000Z");
    expect(await hydrateLabels(db, [actor], [external])).toEqual({});
  });
});

describe("interrupted moderator reconciliation", () => {
  it("drains a large local deletion backlog across complete fresh listings", async () => {
    const db = await setupReconcile();
    await ingestRecords(db, Array.from({ length: 1001 }, (_, i) =>
      action(`deleted-${i}`, { subject: actor, action: "!hide" }),
    ), config);
    const sql: string[] = [];
    const bounded: Database = {
      dialect: db.dialect,
      prepare(statement) { sql.push(statement); return db.prepare(statement); },
      batch: (statements) => db.batch(statements),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ records: [] }));
    try {
      await reconcileModeratorActions(bounded, config);
      expect(await actions(db)).toHaveLength(1);
      expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(0);
      // A failed listing cannot reuse an earlier absence proof to undo more.
      fetchMock.mockResolvedValueOnce(new Response("retry", { status: 503 }));
      await reconcileModeratorActions(bounded, config);
      expect(await actions(db)).toHaveLength(1);
      await reconcileModeratorActions(bounded, config);
      expect(await actions(db)).toEqual([]);
      expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(1);
      expect(sql.filter((s) => s.startsWith("SELECT uri, cid FROM records_")))
        .toEqual([]); // An empty listing needs no local CID lookup at all.
      const missing = sql.filter((s) => s.startsWith("SELECT uri FROM records_"));
      expect(missing).toHaveLength(2);
      expect(missing.every((s) => s.includes("LIMIT ?") && !s.includes("ORDER BY"))).toBe(true);
      expect(fetchMock.mock.calls.every(([url]) => !new URL(String(url)).searchParams.has("cursor"))).toBe(true);
    } finally { fetchMock.mockRestore(); }
  });

  it("shares the mutation budget between changed actions and missed deletions", async () => {
    const db = await setupReconcile();
    await ingestRecords(db, [
      ...Array.from({ length: 1000 }, (_, i) => action(`deleted-${i}`, { subject: actor, action: "!hide" })),
      action("updated", { subject: actor, action: "!hide" }),
    ], config);
    const current = { ...remote("updated"), cid: "changed-cid", value: {
      ...remote("updated").value, action: "!warn",
    } };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ records: [current] }));
    try {
      await reconcileModeratorActions(db, config);
      const remaining = await actions(db);
      expect(remaining).toHaveLength(2); // One update and only 999 deletions.
      expect(remaining).toContain(current.uri);
      expect((await hydrateLabels(db, [actor], [moderator]))[actor]!.map((l) => l.val).sort())
        .toEqual(["!hide", "!warn"]);
      await reconcileModeratorActions(db, config);
      expect(await actions(db)).toEqual([current.uri]);
      expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(1);
    } finally { fetchMock.mockRestore(); }
  });

  it("does not let a bounded deletion overwrite a newer live action", async () => {
    const db = await setupReconcile();
    await ingestRecords(db, [action("raced", { subject: actor, action: "!hide" })], config);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // A newer live observation arrives after this listing began. It must
      // survive even though the complete listing does not contain its URI.
      await ingestRecords(db, [{
        ...action("raced", { subject: actor, action: "!takedown" }),
        cid: "new-live-cid",
        source: { id: "jetstream", time_us: Date.now() * 1000 + 1_000_000, revision: null, cursor: null },
      }], config);
      return Response.json({ records: [] });
    });
    try {
      await reconcileModeratorActions(db, config);
      expect(await actions(db)).toEqual([remote("raced").uri]);
      expect((await hydrateLabels(db, [actor], [moderator]))[actor]![0]!.val).toBe("!takedown");
    } finally { fetchMock.mockRestore(); }
  });

  it("commits valid pages and resumes after a later timeout without inferring deletions", async () => {
    const db = await setupReconcile();
    await ingestRecords(db, [action("retained", { subject: "did:plc:retained", action: "!hide" })], config);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ records: [remote("a")], cursor: "next" }))
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json({ records: [remote("b", "did:plc:b")] }));
    try {
      await reconcileModeratorActions(db, config);
      expect(await savedCursor(db)).toBe("next");
      expect(await actions(db)).toEqual([remote("a").uri, remote("retained").uri]);
      await reconcileModeratorActions(db, config);
      expect(new URL(String(fetchMock.mock.calls[2]![0])).searchParams.get("cursor")).toBe("next");
      expect(await savedCursor(db)).toBeUndefined();
      expect(await actions(db)).toEqual([remote("a").uri, remote("b").uri, remote("retained").uri]);
    } finally { fetchMock.mockRestore(); }
  });

  it.each([429, 500, 503])("retains a saved resume cursor on HTTP %s", async (status) => {
    const db = await setupReconcile();
    await db.prepare("INSERT INTO _contrail_meta (key, value) VALUES (?, ?)").bind(cursorKey, "saved").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("retry", { status }));
    try {
      await reconcileModeratorActions(db, config);
      expect(await savedCursor(db)).toBe("saved");
    } finally { fetchMock.mockRestore(); }
  });

  it("does not accept part of a malformed page or infer deletions from it", async () => {
    const db = await setupReconcile();
    await ingestRecords(db, [action("retained", { subject: actor, action: "!hide" })], config);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ records: [remote("a")], cursor: "next" }))
      .mockResolvedValueOnce(Response.json({ records: [remote("b"), null] }));
    try {
      await reconcileModeratorActions(db, config);
      expect(await savedCursor(db)).toBe("next");
      expect(await actions(db)).toEqual([remote("a").uri, remote("retained").uri]);
    } finally { fetchMock.mockRestore(); }
  });

  it("keeps the durable cursor when committing a page fails", async () => {
    const db = await setupReconcile();
    await db.prepare("INSERT INTO _contrail_meta (key, value) VALUES (?, ?)").bind(cursorKey, "saved").run();
    const broken: Database = {
      dialect: db.dialect, prepare: (sql) => db.prepare(sql),
      batch: async () => { throw new Error("Storage unavailable"); },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ records: [remote("a")] }));
    try {
      await reconcileModeratorActions(broken, config);
      expect(await savedCursor(db)).toBe("saved");
      expect(await actions(db)).toEqual([]);
    } finally { fetchMock.mockRestore(); }
  });
});
