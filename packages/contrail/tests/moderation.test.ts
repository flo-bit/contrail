import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG, TEST_POSTGRES } from "./helpers";
import {
  resolveConfig,
  initSchema,
  ingestRecords,
  queryRecords,
  MODERATION_ACTION_NSID,
  applyLabels,
  hydrateLabels,
  createApp,
  visibleRecordSql,
  parseModerationAction,
  moderationActionLexicon,
} from "../src/index";
import { accountUpdateStatements, labelBackfillEnqueueStatements } from "../src/core/moderation";
import {
  reconcileModeratorActions,
  runLabelBackfillQueue,
  runModerationRecounts,
} from "../src/core/moderation-sync";
import type { Database } from "../src/index";

const moderator = "did:plc:moderator";
const actor = "did:plc:test";
const external = "did:plc:external";
const config = resolveConfig({
  ...TEST_CONFIG,
  moderation: { moderators: [moderator], reports: false },
  labels: { sources: [{ did: external, enforce: true }] },
});
let db: Database;
let time = 100;
// Node 22's bundled SQLite lacks FTS5, unlike newer Node and D1.
let hasFts = false;
try {
  await createTestDb().prepare("CREATE VIRTUAL TABLE __moderation_fts USING fts5(content)").run();
  hasFts = true;
} catch {}

// Real-format CIDs: action subjectCid values are validated.
const otherVersion = "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const post = makeEvent({ cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5yvzh5lsjbsmwu4" });
function action(
  value: any,
  rkey = "action",
  did = moderator,
  operation: "create" | "update" | "delete" = "create",
) {
  return makeEvent({
    uri: `at://${did}/${MODERATION_ACTION_NSID}/${rkey}`,
    did,
    collection: MODERATION_ACTION_NSID,
    rkey,
    operation,
    record:
      operation === "delete"
        ? null
        : { ...value, createdAt: value?.createdAt ?? "2026-01-01T00:00:00Z" },
    cid: `cid${time}`,
    time_us: ++time,
    indexed_at: time,
  });
}
async function rows() {
  return (await queryRecords(db, config, { collection: "event" })).records;
}

beforeEach(async () => {
  db = createTestDb();
  time = 100;
  await initSchema(db, config);
  await ingestRecords(db, [post], config);
});

describe("moderation enforcement", () => {
  it("hides DID actions across list, get and profiles regardless of accepted labelers", async () => {
    await ingestRecords(
      db,
      [action({ subject: actor, action: "!takedown" })],
      config,
    );
    expect(await rows()).toEqual([]);
    const app = createApp(db, config);
    expect(
      (
        await app.request(
          `/xrpc/com.example.event.getRecord?uri=${encodeURIComponent(post.uri)}`,
          { headers: { "atproto-accept-labelers": external } },
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/xrpc/com.example.getProfile?actor=${actor}`)).status,
    ).toBe(404);
  });
  it("rejects actions by untrusted authors, malformed subjects and private evidence", async () => {
    await ingestRecords(
      db,
      [
        action({ subject: actor, action: "!hide" }, "untrusted", actor),
        action({
          subject: "at://someone.test/com.example.post/a",
          action: "!hide",
        }),
        action({ subject: actor, action: "!hide", reason: "private evidence" }),
      ],
      config,
    );
    expect(await rows()).toHaveLength(1);
    expect(
      (await db.prepare("SELECT * FROM moderation_actions").all()).results,
    ).toEqual([]);
  });
  it("rejects malformed subjectCid values and unsupported override actions", () => {
    expect(parseModerationAction({ subject: actor, action: "override", createdAt: "2026-01-01T00:00:00Z" })).toBeNull();
    for (const subjectCid of ["not a cid", "bafy" + "a".repeat(300)])
      expect(parseModerationAction({ subject: post.uri, subjectCid, action: "!hide", createdAt: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(parseModerationAction({ subject: post.uri, subjectCid: otherVersion, action: "!hide", createdAt: "2026-01-01T00:00:00Z" })).not.toBeNull();
    expect(moderationActionLexicon.defs.main.record.properties.action).toBeDefined();
  });
  it("retracts the old subject on update and keeps duplicate action records until all are deleted", async () => {
    await ingestRecords(
      db,
      [
        action({ subject: actor, action: "!hide" }, "a"),
        action({ subject: actor, action: "!hide" }, "b"),
      ],
      config,
    );
    await ingestRecords(db, [action(null, "a", moderator, "delete")], config);
    expect(await rows()).toHaveLength(0);
    await ingestRecords(
      db,
      [
        action(
          { subject: "did:plc:someoneelse", action: "!warn" },
          "b",
          moderator,
          "update",
        ),
      ],
      config,
    );
    expect(await rows()).toHaveLength(1);
    expect(await hydrateLabels(db, [actor], [moderator])).toEqual({});
  });
  it.each(["2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"])(
    "an expired duplicate does not cancel a permanent action (createdAt=%s)",
    async (createdAt) => {
      await ingestRecords(db, [
        action({ subject: actor, action: "!hide", createdAt: "2025-01-01T00:00:00Z" }, "a"),
        action({ subject: actor, action: "!hide", createdAt, expiresAt: "2026-01-02T00:00:00Z" }, "b"),
      ], config);
      expect(await rows()).toHaveLength(0);
      expect((await hydrateLabels(db, [actor], [moderator]))[actor]).toEqual([
        expect.objectContaining({ val: "!hide", cts: "2025-01-01T00:00:00.000Z" }),
      ]);
      await ingestRecords(db, [action(null, "b", moderator, "delete")], config);
      expect(await rows()).toHaveLength(0);
      await ingestRecords(db, [action(null, "a", moderator, "delete")], config);
      expect(await rows()).toHaveLength(1);
      expect(await hydrateLabels(db, [actor], [moderator])).toEqual({});
    },
  );
  it.each(["2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"])(
    "a CID-pinned duplicate does not cancel an unpinned action (createdAt=%s)",
    async (createdAt) => {
      await ingestRecords(db, [
        action({ subject: post.uri, action: "!hide", createdAt: "2025-01-01T00:00:00Z" }, "a"),
        action({ subject: post.uri, subjectCid: otherVersion, action: "!hide", createdAt }, "b"),
      ], config);
      expect(await rows()).toHaveLength(0);
      const cids = new Map([[post.uri, post.cid]]);
      expect((await hydrateLabels(db, [post.uri], [moderator], cids))[post.uri]).toEqual([
        expect.objectContaining({ val: "!hide", cts: "2025-01-01T00:00:00.000Z" }),
      ]);
      await ingestRecords(db, [action(null, "a", moderator, "delete")], config);
      expect(await rows()).toHaveLength(1);
      expect(await hydrateLabels(db, [post.uri], [moderator], cids)).toEqual({});
      await ingestRecords(db, [makeEvent({ operation: "update", cid: otherVersion, time_us: 2_000_000 })], config);
      expect(await rows()).toHaveLength(0);
      expect((await hydrateLabels(db, [post.uri], [moderator], new Map([[post.uri, otherVersion]])))[post.uri]).toHaveLength(1);
    },
  );
  it("retains same-second actions pinned to distinct versions", async () => {
    await ingestRecords(db, [
      action({ subject: post.uri, subjectCid: post.cid, action: "!hide" }, "a"),
      action({ subject: post.uri, subjectCid: otherVersion, action: "!hide" }, "b"),
    ], config);
    expect(await rows()).toHaveLength(0);
    expect((await hydrateLabels(db, [post.uri], [moderator], new Map([[post.uri, post.cid]])))[post.uri][0].cid).toBe(post.cid);
    await ingestRecords(db, [makeEvent({ operation: "update", cid: otherVersion, time_us: 2_000_000 })], config);
    expect(await rows()).toHaveLength(0);
    await ingestRecords(db, [action(null, "b", moderator, "delete")], config);
    expect(await rows()).toHaveLength(1);
  });
  it("rejects a moderator DID that is also configured as a labels source", () => {
    expect(() =>
      resolveConfig({
        ...TEST_CONFIG,
        moderation: { moderators: [moderator], reports: false },
        labels: { sources: [{ did: moderator }] },
      }),
    ).toThrow("cannot also be a labels source");
    // Re-resolving an already-resolved config keeps working.
    expect(() => resolveConfig(config)).not.toThrow();
  });
  it("removes implicitly derived moderator trust when re-resolving a changed config", async () => {
    const c = resolveConfig({
      ...config,
      moderation: { moderators: [], reports: false },
    });
    expect(c.labels?.sources.some((s) => s.did === moderator)).toBe(false);
    await initSchema(db, c);
    expect(
      await db
        .prepare("SELECT 1 FROM moderation_sources WHERE did = ? AND moderator = 1")
        .bind(moderator)
        .first(),
    ).toBeNull();
  });
  it("CID-pinned hides only affect that version and record hides do not hide the actor", async () => {
    await ingestRecords(
      db,
      [action({ subject: post.uri, subjectCid: post.cid, action: "!hide" })],
      config,
    );
    expect(await rows()).toHaveLength(0);
    await ingestRecords(
      db,
      [
        makeEvent({
          operation: "update",
          cid: "newversion",
          time_us: 2_000_000,
        }),
      ],
      config,
    );
    expect(await rows()).toHaveLength(1);
  });
  it("attaches non-hide labels but does not enforce a source without enforce=true", async () => {
    await applyLabels(db, [
      { src: external, uri: actor, val: "spam", cts: "2026-01-01T00:00:00Z" },
      {
        src: "did:plc:other",
        uri: actor,
        val: "!hide",
        cts: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(await rows()).toHaveLength(1);
    expect((await hydrateLabels(db, [actor], [external]))[actor][0].val).toBe(
      "spam",
    );
  });
  it("does not resurrect old labels when the newest label/retraction expires", async () => {
    await applyLabels(db, [
      { src: external, uri: actor, val: "!hide", cts: "2025-01-01T00:00:00Z" },
      {
        src: external,
        uri: actor,
        val: "!hide",
        neg: true,
        cts: "2026-01-01T00:00:00Z",
        exp: "2026-01-02T00:00:00Z",
      },
    ]);
    expect(await rows()).toHaveLength(1);
    expect(await hydrateLabels(db, [actor], [external])).toEqual({});
  });
  it("evaluates expired replacements without waiting for a cron sweep", async () => {
    await applyLabels(db, [
      { src: external, uri: actor, val: "!hide", cts: "2025-01-01T00:00:00Z" },
      {
        src: external,
        uri: actor,
        val: "!hide",
        cts: "2026-01-01T00:00:00Z",
        exp: "2026-01-02T00:00:00Z",
      },
    ]);
    expect(await rows()).toHaveLength(1);
    await applyLabels(db, [
      { src: external, uri: actor, val: "!hide", cts: "2026-02-01T00:00:00Z" },
    ]);
    expect(await rows()).toHaveLength(0);
  });
  it("keeps counts and relation hydration consistent across deactivate/reactivate", async () => {
    const rsvp = makeEvent({
      uri: "at://did:plc:rsvp/community.lexicon.calendar.rsvp/a",
      did: "did:plc:rsvp",
      collection: "community.lexicon.calendar.rsvp",
      record: {
        subject: { uri: post.uri },
        status: "community.lexicon.calendar.rsvp#going",
      },
    });
    await ingestRecords(db, [rsvp], config);
    expect((await rows())[0].counts?.rsvp).toBe(1);
    await db.batch(
      accountUpdateStatements(
        db,
        [
          {
            did: rsvp.did,
            active: false,
            status: "deactivated",
            timeUs: 10,
            cursor: 10,
          },
        ],
        config,
      ),
    );
    // Stored counts are corrected by the bounded recount queue.
    await runModerationRecounts(db, config);
    expect((await rows())[0].counts?.rsvp).toBeUndefined();
    expect(
      (await db.prepare("SELECT * FROM moderation_recount_queue").all()).results,
    ).toEqual([]);
    const app = createApp(db, config);
    const response = await app.request(
      `/xrpc/com.example.event.listRecords?hydrateRsvps=10`,
    );
    const body: any = await response.json();
    expect(body.records[0].rsvps).toBeUndefined();
    await db.batch(
      accountUpdateStatements(
        db,
        [{ did: rsvp.did, active: true, timeUs: 11, cursor: 11 }],
        config,
      ),
    );
    await runModerationRecounts(db, config);
    expect((await rows())[0].counts?.rsvp).toBe(1);
  });
  it("counts new children of a hidden actor as hidden immediately", async () => {
    await db.batch(
      accountUpdateStatements(
        db,
        [{ did: "did:plc:rsvp", active: false, status: "deactivated", timeUs: 1, cursor: 1 }],
        config,
      ),
    );
    // Unknown actor: nothing stored, so their first RSVP still counts.
    expect(
      (await db.prepare("SELECT * FROM account_state").all()).results,
    ).toEqual([]);
    const rsvp = (did: string) =>
      makeEvent({
        uri: `at://${did}/community.lexicon.calendar.rsvp/a`,
        did,
        collection: "community.lexicon.calendar.rsvp",
        record: { subject: { uri: post.uri }, status: "community.lexicon.calendar.rsvp#going" },
      });
    await ingestRecords(db, [rsvp("did:plc:rsvp")], config);
    await db.batch(
      accountUpdateStatements(
        db,
        [{ did: "did:plc:rsvp", active: false, status: "deactivated", timeUs: 2, cursor: 2 }],
        config,
      ),
    );
    await ingestRecords(db, [rsvp("did:plc:other")], config);
    // The second RSVP's recount already excludes the hidden actor.
    expect((await rows())[0].counts?.rsvp).toBe(1);
  });
  it("queues recounts only when a subject's visibility actually changes", async () => {
    const rsvp = makeEvent({
      uri: "at://did:plc:rsvp/community.lexicon.calendar.rsvp/a",
      did: "did:plc:rsvp",
      collection: "community.lexicon.calendar.rsvp",
      record: { subject: { uri: post.uri }, status: "community.lexicon.calendar.rsvp#going" },
    });
    await ingestRecords(db, [rsvp], config);
    const queue = async () =>
      (await db.prepare("SELECT subject FROM moderation_recount_queue").all()).results;
    const update = (cursor: number, active: boolean) =>
      db.batch(accountUpdateStatements(
        db,
        [{ did: rsvp.did, active, ...(active ? {} : { status: "deactivated" }), timeUs: cursor, cursor }],
        config,
      ));
    // Routine active event for a visible actor: nothing to recount.
    await update(1, true);
    expect(await queue()).toEqual([]);
    await update(2, false);
    expect(await queue()).toEqual([{ subject: rsvp.did }]);
    await runModerationRecounts(db, config);
    // A second hide reason for an already hidden actor changes nothing.
    await ingestRecords(db, [action({ subject: rsvp.did, action: "!takedown" })], config);
    await update(3, false);
    expect(await queue()).toEqual([]);
    // Lifting one of two reasons keeps the actor hidden.
    await update(4, true);
    expect(await queue()).toEqual([]);
    expect(
      (await db.prepare("SELECT * FROM moderation_hidden_snapshot").all()).results,
    ).toEqual([]);
  });
  it("queues recounts at future visibility boundaries", async () => {
    const rsvp = makeEvent({
      uri: "at://did:plc:rsvp/community.lexicon.calendar.rsvp/a",
      did: "did:plc:rsvp",
      collection: "community.lexicon.calendar.rsvp",
      record: { subject: { uri: post.uri }, status: "community.lexicon.calendar.rsvp#going" },
    });
    await ingestRecords(db, [rsvp], config);
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    await applyLabels(
      db,
      [{ src: external, uri: rsvp.did, val: "!hide", cts: "2026-01-01T00:00:00Z", exp }],
      { config },
    );
    const queued = (
      await db.prepare("SELECT due_at FROM moderation_recount_queue ORDER BY due_at").all<{ due_at: number }>()
    ).results.map((r) => Number(r.due_at));
    expect(queued).toEqual([0, Math.floor(Date.parse(exp) / 1000)]);
    await runModerationRecounts(db, config);
    expect((await rows())[0].counts?.rsvp).toBeUndefined();
    expect(
      (await db.prepare("SELECT * FROM moderation_recount_queue").all()).results,
    ).toHaveLength(1);
  });
  // EXPLAIN QUERY PLAN is SQLite syntax.
  it.skipIf(TEST_POSTGRES)("enforcement lookups are indexed, never a scan of labels or account state", async () => {
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT uri FROM records_event r WHERE ${visibleRecordSql("r")}`,
      )
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join("\n");
    expect(details).toMatch(/SEARCH mh USING INDEX idx_moderation_hidden_subject/);
    expect(details).not.toMatch(/SCAN (l|labels|account_state)\b/);
  });
  it("retracts an action edited into an invalid record", async () => {
    await ingestRecords(db, [action({ subject: actor, action: "!hide" })], config);
    expect(await rows()).toHaveLength(0);
    await ingestRecords(
      db,
      [action({ subject: actor, action: "!hide", note: "x" }, "action", moderator, "update")],
      config,
    );
    expect(await rows()).toHaveLength(1);
  });
  it("clamps forward-dated actions to their source observation time, stably", async () => {
    const observedUs = (Date.now() - 60_000) * 1000;
    const event = {
      ...action({ subject: actor, action: "!hide", createdAt: "2999-01-01T00:00:00Z" }),
      source: { id: "jetstream", time_us: observedUs, revision: null, cursor: null },
    };
    const cts = async () =>
      Number((await db.prepare("SELECT cts FROM moderation_actions").first<{ cts: number }>())!.cts);
    await ingestRecords(db, [event], config);
    expect(await cts()).toBe(observedUs / 1000);
    // Re-projecting the same event later must not move the action forward.
    await db.prepare("DELETE FROM record_versions").run();
    await db.prepare(`DELETE FROM records_moderationAction`).run();
    await ingestRecords(db, [event], config);
    expect(await cts()).toBe(observedUs / 1000);
  });
  it("hidden records do not consume pagination limits", async () => {
    await ingestRecords(db, [
      makeEvent({
        uri: "at://did:plc:ok/community.lexicon.calendar.event/a",
        did: "did:plc:ok",
        time_us: 2,
      }),
      action({ subject: actor, action: "!hide" }),
    ], config);
    const result = await queryRecords(db, config, { collection: "event", limit: 1 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].did).toBe("did:plc:ok");
  });
  it.skipIf(!hasFts)("hidden records do not consume search limits", async () => {
    const c = resolveConfig({
      ...config,
      collections: {
        ...config.collections,
        event: { ...config.collections.event, searchable: ["name"] },
      },
    });
    await initSchema(db, c);
    await ingestRecords(
      db,
      [
        makeEvent({
          uri: "at://did:plc:ok/community.lexicon.calendar.event/a",
          did: "did:plc:ok",
          time_us: 2,
        }),
        action({ subject: actor, action: "!hide" }),
      ],
      c,
    );
    const result = await queryRecords(db, c, {
      collection: "event",
      search: "Test",
      limit: 1,
    });
    expect(result.records[0].did).toBe("did:plc:ok");
  });
});

describe("account lifecycle", () => {
  it.each([
    "deleted",
    "deactivated",
    "takendown",
    "suspended",
    "unknown-status",
  ])("retains but hides %s and rejects stale state", async (status) => {
    await db.batch(
      accountUpdateStatements(
        db,
        [{ did: actor, active: false, status, timeUs: 2, cursor: 2 }],
        config,
      ),
    );
    expect(await rows()).toHaveLength(0);
    expect(
      (await db.prepare("SELECT * FROM records_event").all()).results,
    ).toHaveLength(1);
    await db.batch(
      accountUpdateStatements(
        db,
        [{ did: actor, active: true, timeUs: 1, cursor: 1 }],
        config,
      ),
    );
    expect(await rows()).toHaveLength(0);
    await db.batch(
      accountUpdateStatements(
        db,
        [{ did: actor, active: true, timeUs: 3, cursor: 3 }],
        config,
      ),
    );
    expect(await rows()).toHaveLength(1);
  });
});

describe("label admission and recovery", () => {
  it("stores JSON signature bytes without treating the signature as verified", async () => {
    await applyLabels(db, [
      {
        src: external,
        uri: actor,
        val: "spam",
        cts: "2026-01-01T00:00:00Z",
        sig: { $bytes: "AQID" },
      },
    ]);
    const row = await db
      .prepare("SELECT sig FROM labels WHERE src = ?")
      .bind(external)
      .first<{ sig: Uint8Array }>();
    expect(Array.from(row!.sig)).toEqual([1, 2, 3]);
  });
  it("rechecks an early record-only backfill when the identity becomes known, but not on later refreshes", async () => {
    const c = resolveConfig({
      ...config,
      labels: { sources: [{ did: external, subjects: "known" }] },
    });
    const did = "did:plc:late-identity";
    await db.batch(labelBackfillEnqueueStatements(db, [did], c));
    await db
      .prepare("UPDATE label_backfill_queue SET completed = 1 WHERE did = ?")
      .bind(did)
      .run();
    await db.batch([
      ...labelBackfillEnqueueStatements(db, [did], c, true),
      db
        .prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)")
        .bind(did),
    ]);
    expect(
      (await db
        .prepare("SELECT completed FROM label_backfill_queue WHERE did = ?")
        .bind(did)
        .first<{ completed: number }>())!.completed,
    ).toBe(0);
    await db
      .prepare("UPDATE label_backfill_queue SET completed = 1 WHERE did = ?")
      .bind(did)
      .run();
    await db.batch(labelBackfillEnqueueStatements(db, [did], c, true));
    expect(
      (await db
        .prepare("SELECT completed FROM label_backfill_queue WHERE did = ?")
        .bind(did)
        .first<{ completed: number }>())!.completed,
    ).toBe(1);
  });
  it("filters values and unknown subjects but always retains stored retractions", async () => {
    const source = {
      did: external,
      values: ["spam"],
      subjects: "known" as const,
    };
    await db
      .prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)")
      .bind(actor)
      .run();
    const label = {
      src: external,
      uri: actor,
      val: "spam",
      cts: "2026-01-01T00:00:00Z",
    };
    expect(
      await applyLabels(
        db,
        [
          label,
          { ...label, uri: "did:plc:unknown" },
          { ...label, val: "porn" },
        ],
        { source },
      ),
    ).toBe(1);
    await db.prepare("DELETE FROM identities").run();
    expect(
      await applyLabels(
        db,
        [{ ...label, neg: true, cts: "2026-02-01T00:00:00Z" }],
        { source: { ...source, values: [] } },
      ),
    ).toBe(1);
    expect(await hydrateLabels(db, [actor], [external])).toEqual({});
  });
  it("queues newly admitted DIDs and checkpoints backfill pages", async () => {
    const c = resolveConfig({
      ...config,
      labels: {
        sources: [
          {
            did: external,
            endpoint: "https://labeler.example",
            subjects: "known",
            values: ["spam"],
          },
        ],
      },
    });
    await initSchema(db, c);
    await ingestRecords(
      db,
      [
        makeEvent({
          did: actor,
          uri: `at://${actor}/community.lexicon.calendar.event/b`,
          rkey: "b",
          time_us: ++time,
        }),
        makeEvent({
          did: "did:plc:new",
          uri: "at://did:plc:new/community.lexicon.calendar.event/a",
          time_us: ++time,
        }),
      ],
      c,
    );
    expect(
      (await db.prepare("SELECT * FROM label_backfill_queue").all()).results,
    ).toHaveLength(2);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            labels: [
              {
                src: external,
                uri: actor,
                val: "spam",
                cts: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        ),
    );
    try {
      await runLabelBackfillQueue(db, c);
      expect(
        (
          await db
            .prepare("SELECT * FROM label_backfill_queue WHERE completed = 0")
            .all()
        ).results,
      ).toEqual([]);
      expect(
        (await hydrateLabels(db, [actor], [external]))[actor],
      ).toHaveLength(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("retracts missed deletions only after a complete listing", async () => {
    await ingestRecords(
      db,
      [action({ subject: actor, action: "!hide" })],
      config,
    );
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(moderator, "moderator.example", "https://pds.example", Date.now())
      .run();
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ records: [] }));
    try {
      await reconcileModeratorActions(db, config);
      expect(await rows()).toHaveLength(1);
    } finally {
      mock.mockRestore();
    }
  });
  it("bounds listings at 10 pages without inferring deletions on truncation", async () => {
    const stale = action({ subject: actor, action: "!hide" }, "stale");
    await ingestRecords(db, [stale], config);
    await db
      .prepare("INSERT INTO identities (did, pds, resolved_at) VALUES (?, ?, ?)")
      .bind(moderator, "https://pds.example", Date.now())
      .run();
    // Twelve remote actions, one per page; `stale` was deleted remotely.
    const remote = Array.from({ length: 12 }, (_, i) => ({
      uri: `at://${moderator}/${MODERATION_ACTION_NSID}/r${String(i).padStart(2, "0")}`,
      cid: `remote${i}`,
      value: {
        $type: MODERATION_ACTION_NSID,
        subject: `did:plc:remote${i}`,
        action: "!hide",
        createdAt: "2026-01-01T00:00:00Z",
      },
    }));
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      const index = cursor ? Number(cursor) : 0;
      return Response.json({
        records: [remote[index]],
        ...(index + 1 < remote.length ? { cursor: String(index + 1) } : {}),
      });
    });
    const actions = async () =>
      (await db.prepare("SELECT uri FROM moderation_actions ORDER BY uri").all<{ uri: string }>())
        .results.map((r) => r.uri);
    try {
      await reconcileModeratorActions(db, config);
      expect(await actions()).toEqual([...remote.slice(0, 10).map((r) => r.uri), stale.uri]);
    } finally {
      mock.mockRestore();
    }
  });
  it("reconciles unchanged actions without any database writes", async () => {
    const created = action({ subject: actor, action: "!hide" });
    await ingestRecords(db, [created], config);
    await db
      .prepare("INSERT INTO identities (did, pds, resolved_at) VALUES (?, ?, ?)")
      .bind(moderator, "https://pds.example", Date.now())
      .run();
    let batches = 0;
    const counting: Database = {
      dialect: db.dialect,
      prepare: (sql) => db.prepare(sql),
      batch: (stmts) => {
        batches++;
        return db.batch(stmts);
      },
    };
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        records: [
          { uri: created.uri, cid: created.cid, value: JSON.parse(created.record!) },
        ],
      }),
    );
    try {
      await reconcileModeratorActions(counting, config);
      expect(batches).toBe(0);
      expect(await rows()).toHaveLength(0);
    } finally {
      mock.mockRestore();
    }
  });
  it("does not reconcile deletions after a failed listing", async () => {
    await ingestRecords(
      db,
      [action({ subject: actor, action: "!hide" })],
      config,
    );
    await db
      .prepare(
        "INSERT INTO identities (did, pds, resolved_at) VALUES (?, ?, ?)",
      )
      .bind(moderator, "https://pds.example", Date.now())
      .run();
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("oops", { status: 500 }));
    try {
      await reconcileModeratorActions(db, config);
      expect(await rows()).toHaveLength(0);
    } finally {
      mock.mockRestore();
    }
  });
});
