import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillPending, backfillUser, createApp, discoverDIDs, getDependentNsids,
  getDiscoverableNsids, getLastCursor, ingestRecords, initSchema, PdsSnapshotSource,
  processNotifyUris, queryRecords, resolveConfig, retryPendingBackfills,
  type CollectionConfig, type Database,
} from "../src/index";
import { __resetPdsCachesForTests } from "../src/core/client";
import { loadKnownActorDids } from "../src/core/db/records";
import { createTestDb, makeEvent } from "./helpers";

const BOT = "did:plc:bot";
const OTHER = "did:plc:other";
const ITEMS = "app.bsky.graph.listitem";
const EVENT = "community.lexicon.calendar.event";
const LIST = `at://${BOT}/app.bsky.graph.list/managed`;

function config(item: CollectionConfig = { collection: ITEMS, repos: [BOT] }) {
  return resolveConfig({
    namespace: "com.example", profiles: [], constellation: false,
    relays: ["https://relay.test"],
    networkOverrides: { additionalAllowedHosts: ["pds.allowed.test"] },
    collections: {
      event: { collection: EVENT },
      item,
      follow: { collection: "app.bsky.graph.follow", discover: false },
    },
  });
}

function item(did: string, rkey = "one", operation: "create" | "update" | "delete" = "create") {
  return makeEvent({
    did, uri: `at://${did}/${ITEMS}/${rkey}`, collection: ITEMS, rkey, operation,
    record: operation === "delete" ? null : { $type: ITEMS, subject: OTHER, list: LIST },
  });
}

async function seedIdentity(db: Database, did = BOT) {
  await db.prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
    .bind(did, `${did.split(":").pop()}.test`, "https://pds.allowed.test", Date.now()).run();
}

async function work(db: Database) {
  return (await db.prepare("SELECT did, collection, completed FROM backfills ORDER BY collection, did")
    .all<{ did: string; collection: string; completed: number }>()).results;
}

afterEach(() => { vi.restoreAllMocks(); __resetPdsCachesForTests(); });

describe("repository-scoped collections", () => {
  it("keeps the three acquisition modes distinct and resolution idempotent", () => {
    const resolved = config();
    expect(getDiscoverableNsids(resolved)).toEqual([EVENT]);
    expect(getDependentNsids(resolved)).toEqual(["app.bsky.graph.follow"]);
    expect(resolved.collections.item.discover).toBeUndefined();
    expect(resolveConfig(resolved).collections).toEqual(resolved.collections);
  });

  it.each([
    { repos: [] }, { repos: ["bot.test"] }, { repos: [BOT, BOT] },
    { repos: [BOT], discover: true }, { repos: [BOT], discover: false },
    { repos: "did:plc:bot" }, { repos: [null] },
  ])("rejects invalid or ambiguous scope: %j", (scope) => {
    expect(() => config({ collection: ITEMS, ...scope } as CollectionConfig)).toThrow(/repos/);
  });

  it("rejects ambiguous aliases for a scoped NSID", () => {
    const resolved = config();
    expect(() => resolveConfig({ ...resolved, collections: {
      ...resolved.collections, anotherItem: { collection: ITEMS },
    } })).toThrow(/multiple aliases/);
  });

  it("admits only configured publishers, including deletes, without prior actor discovery", async () => {
    const resolved = config({ collection: ITEMS, repos: [BOT, "did:web:second.test"] });
    const db = createTestDb();
    await initSchema(db, resolved);
    const result = await ingestRecords(db, [
      item(BOT), item(OTHER), item(OTHER, "update", "update"), item(OTHER, "delete", "delete"),
      item("did:web:second.test"),
    ], resolved, { knownDids: new Set([OTHER]) });
    expect(result.dropped.unknownActor).toBe(3);
    expect(result.discoveredDids).toEqual([]);
    expect((await queryRecords(db, resolved, { collection: "item" })).records.map((r) => r.did).sort())
      .toEqual([BOT, "did:web:second.test"].sort());
    await ingestRecords(db, [item(BOT, "one", "delete")], resolved, { knownDids: new Set() });
    expect((await queryRecords(db, resolved, { collection: "item" })).records.map((r) => r.did))
      .toEqual(["did:web:second.test"]);
  });

  it("still applies record filters to scoped publishers", async () => {
    const resolved = config({ collection: ITEMS, repos: [BOT], recordFilter: (record) => record.list === LIST });
    const db = createTestDb();
    await initSchema(db, resolved);
    await ingestRecords(db, [item(BOT)], resolved);
    const result = await ingestRecords(db, [{ ...item(BOT, "one", "update"), record: JSON.stringify({ list: "at://did:plc:another/app.bsky.graph.list/other" }) }], resolved);
    expect(result.dropped.recordFilter).toBe(1);
    expect((await queryRecords(db, resolved, { collection: "item" })).records).toEqual([]);
  });

  it("rejects source metadata that disagrees with the scoped record URI", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    const result = await ingestRecords(db, [{ ...item(BOT), uri: item(OTHER).uri }], resolved);
    expect(result.dropped.invalidRecord).toBe(1);
    expect((await queryRecords(db, resolved, { collection: "item" })).records).toEqual([]);
  });

  it("does not let a scoped record admit an unrelated dependent sibling", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    const follow = makeEvent({ did: BOT, collection: "app.bsky.graph.follow",
      uri: `at://${BOT}/app.bsky.graph.follow/one`, record: { subject: OTHER } });
    const result = await ingestRecords(db, [item(BOT), follow], resolved, { knownDids: new Set() });
    expect(result.accepted.map((r) => r.collection)).toEqual([ITEMS]);
    expect(result.discoveredDids).toEqual([]);
  });

  it("seeds exact backfill pairs without expanding into dependent collections and preserves progress", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    expect(await work(db)).toEqual([{ did: BOT, collection: ITEMS, completed: 0 }]);
    expect(await loadKnownActorDids(db, resolved)).not.toContain(BOT);
    await db.prepare("UPDATE backfills SET completed = 1, pds_cursor = ? WHERE did = ? AND collection = ?")
      .bind("saved", BOT, ITEMS).run();
    await initSchema(db, resolved);
    expect(await work(db)).toEqual([{ did: BOT, collection: ITEMS, completed: 1 }]);
    expect(await db.prepare("SELECT pds_cursor FROM backfills WHERE did = ? AND collection = ?")
      .bind(BOT, ITEMS).first()).toEqual({ pds_cursor: "saved" });
  });

  it("does not relay-discover scoped collections or enroll relay actors in them", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("relay.test");
      expect(url.searchParams.get("collection")).toBe(EVENT);
      return Response.json({ repos: [{ did: OTHER }] });
    });
    await discoverDIDs(db, resolved, Infinity, { captureReplayBoundary: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await work(db)).toEqual([
      { did: OTHER, collection: "app.bsky.graph.follow", completed: 0 },
      { did: BOT, collection: ITEMS, completed: 0 },
      { did: OTHER, collection: EVENT, completed: 0 },
    ]);
  });

  it("blocks out-of-scope notify and actor read-through before any PDS request", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const result = await processNotifyUris(db, resolved, [item(OTHER).uri]);
    expect(result.errors).toEqual([expect.stringContaining("outside configured scope")]);
    const response = await createApp(db, resolved).request(`/xrpc/com.example.item.listRecords?actor=${OTHER}`);
    expect(response.status).toBe(200);
    expect((await response.json()).records).toEqual([]);
    expect(await backfillUser(db, OTHER, ITEMS, Infinity, resolved)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("backfills seeded repositories with existing completion state, not every known actor", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    await seedIdentity(db);
    await seedIdentity(db, OTHER);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("pds.allowed.test");
      expect(url.searchParams.get("repo")).toBe(BOT);
      expect(url.searchParams.get("collection")).toBe(ITEMS);
      expect(await getLastCursor(db)).not.toBeNull();
      return Response.json({ records: [{ uri: item(BOT).uri, cid: "cid-one", value: { $type: ITEMS, list: LIST, subject: OTHER } }] });
    });
    const result = await retryPendingBackfills(db, resolved);
    expect(result.completed).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await queryRecords(db, resolved, { collection: "item" })).records).toHaveLength(1);
    expect(await work(db)).toEqual([{ did: BOT, collection: ITEMS, completed: 1 }]);
  });

  it("retires stale manual backfill work without resolving or fetching out-of-scope repositories", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    await db.prepare("UPDATE backfills SET completed = 1").run();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    for (const run of [backfillPending, retryPendingBackfills]) {
      await db.prepare("INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0)").bind(OTHER, ITEMS).run();
      await run(db, resolved);
      expect(await work(db)).toEqual([{ did: BOT, collection: ITEMS, completed: 1 }]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prepares scoped-only snapshots without unrelated relay discovery and paginates the bot PDS", async () => {
    const resolved = config();
    const db = createTestDb();
    await initSchema(db, resolved);
    await seedIdentity(db);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("pds.allowed.test");
      expect(url.searchParams.get("repo")).toBe(BOT);
      expect(url.searchParams.get("collection")).toBe(ITEMS);
      return Response.json({ records: [], ...(url.searchParams.has("cursor") ? {} : { cursor: "next" }) });
    });
    const source = new PdsSnapshotSource(db, resolved, { maxRetries: 0 });
    const snapshot = await source.prepare({ collections: [ITEMS] });
    expect(fetch).not.toHaveBeenCalled();
    const batches = [];
    for await (const batch of source.read({ snapshot })) batches.push(batch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batches.at(-1)?.done).toBe(true);
  });

  it("refuses changing/removing durable scope, but permits reordering and adding new empty collections", async () => {
    const db = createTestDb();
    const resolved = config({ collection: ITEMS, repos: [BOT, OTHER] });
    await initSchema(db, resolved);
    await initSchema(db, config({ collection: ITEMS, repos: [OTHER, BOT] }));
    await expect(initSchema(db, config())).rejects.toThrow(/scope changed.*rebuild/);
    await expect(initSchema(db, config({ collection: ITEMS }))).rejects.toThrow(/scope changed.*rebuild/);
    const added = resolveConfig({ ...resolved, collections: {
      ...resolved.collections, pack: { collection: "app.bsky.graph.starterpack", repos: [BOT] },
    } });
    await initSchema(db, added);
    expect(await work(db)).toContainEqual({ did: BOT, collection: "app.bsky.graph.starterpack", completed: 0 });
  });

  it("does not adopt a populated unrestricted collection even on the unchanged-DDL path", async () => {
    const db = createTestDb();
    const unrestricted = config({ collection: ITEMS, discover: true });
    await initSchema(db, unrestricted);
    await ingestRecords(db, [item(OTHER)], unrestricted);
    await expect(initSchema(db, config())).rejects.toThrow(/populated collection.*rebuild/);
  });
});
