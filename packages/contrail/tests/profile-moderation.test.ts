import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  createApp,
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  resolveConfig,
  resolveProfiles,
  type Database,
} from "../src/index";

const did = "did:plc:test";
const moderator = "did:plc:moderator";
const collection = "com.example.profile";
const uri = `at://${did}/${collection}/self`;
const cid = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5yvzh5lsjbsmwu4";
const otherCid = "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

async function setup(options: { missing?: boolean; multiple?: boolean } = {}) {
  const config = resolveConfig({
    ...TEST_CONFIG,
    collections: { ...TEST_CONFIG.collections, profile: { collection, discover: false, methods: [] } },
    profiles: [
      { collection, shortName: "profile" },
      ...(options.multiple ? [{ collection: "com.example.otherProfile", shortName: "otherProfile" }] : []),
    ],
    moderation: { moderators: [moderator], reports: false },
    logger: { log() {}, warn() {}, error() {} },
  });
  const db = createTestDb();
  await initSchema(db, config);
  await db.prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
    .bind(did, "test.example", "https://pds.example", Date.now()).run();
  if (!options.missing) {
    await ingestRecords(db, [makeEvent({ uri, collection, rkey: "self", cid, record: { displayName: "Hidden profile" } })], config);
  }
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  return { db, config, fetch };
}

async function hide(db: Database, config: ReturnType<typeof resolveConfig>, subjectCid?: string) {
  await ingestRecords(db, [makeEvent({
    uri: `at://${moderator}/${MODERATION_ACTION_NSID}/hide`,
    did: moderator,
    collection: MODERATION_ACTION_NSID,
    rkey: "hide",
    record: { subject: uri, action: "!hide", createdAt: "2026-01-01T00:00:00Z", ...(subjectCid ? { subjectCid } : {}) },
  })], config);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("record-scoped profile moderation", () => {
  it.each([false, true])("returns 404 without PDS read-through or an identity fallback (missing indexed record: %s)", async (missing) => {
    const { db, config, fetch } = await setup({ missing });
    await hide(db, config);
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    const response = await createApp(db, config).request(`/xrpc/com.example.getProfile?actor=${did}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Profile not found" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.prepare("SELECT * FROM backfills").all()).results).toEqual([]);
  });

  it("does not resolve identities when every configured profile is hidden", async () => {
    const { db, config, fetch } = await setup();
    await hide(db, config);
    await db.prepare("DELETE FROM identities WHERE did = ?").bind(did).run();
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors a matching CID pin without refetching, and restores visibility for a new version", async () => {
    const { db, config, fetch } = await setup();
    await hide(db, config, cid);
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    expect((await createApp(db, config).request(`/xrpc/com.example.getProfile?actor=${did}`)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();

    await ingestRecords(db, [makeEvent({ uri, collection, rkey: "self", cid: otherCid,
      record: { displayName: "New version" }, time_us: 2_000_000 })], config);
    expect((await resolveProfiles(db, config, [did]))[did]).toMatchObject([
      { uri, cid: otherCid, value: { displayName: "New version" }, handle: "test.example" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hide a profile when the action is pinned to a different CID", async () => {
    const { db, config, fetch } = await setup();
    await hide(db, config, otherCid);
    expect((await resolveProfiles(db, config, [did]))[did]).toMatchObject([{ uri, cid }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns other visible profile collections without refetching the hidden one", async () => {
    const { db, config, fetch } = await setup({ multiple: true });
    const otherUri = `at://${did}/com.example.otherProfile/self`;
    await ingestRecords(db, [makeEvent({ uri: otherUri, collection: "com.example.otherProfile", rkey: "self",
      record: { displayName: "Visible profile" } })], config);
    await hide(db, config);
    expect((await resolveProfiles(db, config, [did]))[did]).toMatchObject([
      { uri: otherUri, value: { displayName: "Visible profile" } },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not create a fallback when another configured profile is absent", async () => {
    const { db, config, fetch } = await setup({ multiple: true });
    await hide(db, config);
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("collection")).toBe("com.example.otherProfile");
  });

  it("keeps the identity fallback for genuinely absent, non-hidden profiles", async () => {
    const { db, config, fetch } = await setup({ missing: true });
    expect(await resolveProfiles(db, config, [did])).toEqual({ [did]: [{ did, handle: "test.example" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks record-scoped hiding after network enrichment", async () => {
    const { db, config } = await setup({ multiple: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await hide(db, config);
      return new Response("{}", { status: 404 });
    }));
    expect(await resolveProfiles(db, config, [did])).toEqual({});
  });

  it.each([
    { starts: null, expires: null, hidden: true },
    { starts: 3_600, expires: null, hidden: false },
    { starts: null, expires: -1, hidden: false },
    { starts: -3_600, expires: 3_600, hidden: true },
  ])("evaluates visibility boundaries in the joined read: %j", async ({ starts, expires, hidden }) => {
    const { db, config, fetch } = await setup();
    const now = Math.floor(Date.now() / 1_000);
    await db.prepare("INSERT INTO moderation_hidden (subject, kind, cid, starts_at, exp) VALUES (?, 'action', ?, ?, ?)")
      .bind(uri, cid, starts === null ? null : now + starts, expires === null ? null : now + expires).run();
    const profiles = await resolveProfiles(db, config, [did]);
    expect(!!profiles[did]).toBe(!hidden);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps hidden indexed profiles on the one-query path", async () => {
    const { db, config, fetch } = await setup();
    await hide(db, config);
    const prepare = vi.spyOn(db, "prepare");
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses account hides without resolving missing identities or profiles", async () => {
    const { db, config, fetch } = await setup({ missing: true, multiple: true });
    await ingestRecords(db, [makeEvent({
      uri: `at://${moderator}/${MODERATION_ACTION_NSID}/account`,
      did: moderator, collection: MODERATION_ACTION_NSID, rkey: "account",
      record: { subject: did, action: "!hide", createdAt: "2026-01-01T00:00:00Z" },
    })], config);
    await db.prepare("DELETE FROM identities WHERE did = ?").bind(did).run();
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks account hiding for cached profiles after another collection's network fetch", async () => {
    const { db, config } = await setup({ multiple: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await ingestRecords(db, [makeEvent({
        uri: `at://${moderator}/${MODERATION_ACTION_NSID}/account`,
        did: moderator, collection: MODERATION_ACTION_NSID, rkey: "account",
        record: { subject: did, action: "!hide", createdAt: "2026-01-01T00:00:00Z" },
      })], config);
      return new Response("{}", { status: 404 });
    }));
    expect(await resolveProfiles(db, config, [did])).toEqual({});
  });

  it("rechecks hiding introduced during missing identity resolution", async () => {
    const { db, config } = await setup();
    await db.prepare("DELETE FROM identities WHERE did = ?").bind(did).run();
    vi.stubGlobal("fetch", vi.fn(async () => {
      await hide(db, config);
      return Response.json({ did, handle: "test.example", pds: "https://pds.example" });
    }));
    expect(await resolveProfiles(db, config, [did])).toEqual({});
  });

  it("returns the current indexed version, not a stale snapshot, after enrichment", async () => {
    const { db, config } = await setup({ multiple: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await ingestRecords(db, [makeEvent({
        uri, collection, rkey: "self", cid: otherCid,
        record: { displayName: "Updated during fetch" }, time_us: 2_000_000,
      })], config);
      return new Response("{}", { status: 404 });
    }));
    expect((await resolveProfiles(db, config, [did]))[did]).toMatchObject([
      { uri, cid: otherCid, value: { displayName: "Updated during fetch" } },
    ]);
  });

  it("does not retain a deleted cached profile after enrichment", async () => {
    const { db, config } = await setup({ multiple: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await ingestRecords(db, [makeEvent({
        uri, collection, rkey: "self", operation: "delete", time_us: 2_000_000,
      })], config);
      return new Response("{}", { status: 404 });
    }));
    expect((await resolveProfiles(db, config, [did]))[did]).toEqual([{ did, handle: "test.example" }]);
  });

  it("restores the retained profile after the action is deleted", async () => {
    const { db, config, fetch } = await setup();
    await hide(db, config);
    expect(await resolveProfiles(db, config, [did])).toEqual({});
    await ingestRecords(db, [makeEvent({
      uri: `at://${moderator}/${MODERATION_ACTION_NSID}/hide`, did: moderator,
      collection: MODERATION_ACTION_NSID, rkey: "hide", operation: "delete", time_us: 2_000_000,
    })], config);
    expect((await resolveProfiles(db, config, [did]))[did]).toMatchObject([{ uri, cid }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
