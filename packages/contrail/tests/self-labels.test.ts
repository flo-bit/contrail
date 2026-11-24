import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLabels,
  createApp,
  createIngestEvent,
  extractSelfLabels,
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  resolveConfig,
  resolveProfiles,
  type LabelsConfig,
} from "../src/index";
import { formatRecord } from "../src/core/router/helpers";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";

const actor = "did:plc:test";
const uri = makeEvent().uri;
const profileCollection = "com.example.profile";
const declarations = (...values: string[]) => ({
  $type: "com.atproto.label.defs#selfLabels",
  values: values.map((val) => ({ val })),
});
let hasFts = false;
try {
  await createTestDb()
    .prepare("CREATE VIRTUAL TABLE __self_fts USING fts5(content)")
    .run();
  hasFts = true;
} catch {}

afterEach(() => vi.unstubAllGlobals());

async function setup(
  labels?: LabelsConfig,
  profiles = false,
  moderation = false,
) {
  const db = createTestDb();
  const config = resolveConfig({
    ...TEST_CONFIG,
    profiles: profiles
      ? [{ collection: profileCollection, shortName: "profile" }]
      : [],
    collections: {
      ...TEST_CONFIG.collections,
      event: {
        ...TEST_CONFIG.collections.event,
        searchable: hasFts ? ["name"] : false,
        pipelineQueries: { custom: async () => ({}) },
      },
      ...(profiles ? { profile: { collection: profileCollection } } : {}),
    },
    feeds: { network: { targets: ["event"] } },
    ...(moderation
      ? { moderation: { moderators: ["did:plc:moderator"], reports: false } }
      : {}),
    labels,
  });
  await initSchema(db, config);
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
    )
    .bind(actor, "test.example", "https://pds.example.com", Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO feed_backfills (actor, feed, completed) VALUES (?, 'network', 1)",
    )
    .bind(actor)
    .run();
  await ingestRecords(
    db,
    [
      makeEvent({
        record: { name: "Sensitive event", labels: declarations("nudity") },
      }),
    ],
    config,
  );
  await db
    .prepare(
      "INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)",
    )
    .bind(actor, uri, TEST_CONFIG.collections.event.collection!, 1000000)
    .run();
  return { db, config, app: createApp(db, config) };
}

async function json(app: ReturnType<typeof createApp>, path: string) {
  const response = await app.request(`/xrpc/com.example.${path}`);
  expect(response.status).toBe(200);
  return { body: (await response.json()) as any, response };
}

describe("self-label normalization", () => {
  it("keeps only standard root declarations, deduplicates, and does not mutate metadata", () => {
    const value = Object.freeze({
      labels: Object.freeze({
        $type: "com.atproto.label.defs#selfLabels",
        values: Object.freeze([
          Object.freeze({
            val: "nudity",
            src: "did:plc:moderator",
            cts: "forged",
            neg: true,
          }),
          Object.freeze({ val: "nudity" }),
          Object.freeze({ val: "custom-warning" }),
          null,
          [],
          { val: 42 },
          { val: "" },
        ]),
      }),
    });
    expect(extractSelfLabels(value)).toEqual([
      { val: "nudity" },
      { val: "custom-warning" },
    ]);
    expect(value.labels.values[0]).toHaveProperty("src");
    expect(extractSelfLabels({ embed: { value } })).toEqual([]);
  });
  it("rejects malformed containers and bounds entries and UTF-8 bytes", () => {
    for (const value of [
      null,
      [],
      "text",
      {},
      { labels: [] },
      { labels: null },
      { labels: { values: [{ val: "nudity" }] } },
      { labels: { $type: "example.app.labels", values: [{ val: "nudity" }] } },
      { labels: declarations(...Array(11).fill("nudity")) },
    ])
      expect(extractSelfLabels(value)).toEqual([]);
    expect(
      extractSelfLabels({
        labels: declarations(
          "a".repeat(128),
          "a".repeat(129),
          "😀".repeat(32),
          "😀".repeat(33),
          "é".repeat(64),
          "é".repeat(65),
        ),
      }),
    ).toEqual([
      { val: "a".repeat(128) },
      { val: "😀".repeat(32) },
      { val: "é".repeat(64) },
    ]);
    expect(
      extractSelfLabels({
        labels: declarations("!hide", "!takedown", " porn "),
      }),
    ).toEqual([{ val: "!hide" }, { val: "!takedown" }, { val: " porn " }]);
  });
  it("formats only the current record and preserves value without database work", () => {
    const row = makeEvent({ record: { labels: declarations("sexual") } });
    expect(formatRecord(row)).toMatchObject({
      selfLabels: [{ val: "sexual" }],
      value: { labels: declarations("sexual") },
    });
    expect(
      formatRecord({ ...row, record: "invalid JSON" }).selfLabels,
    ).toBeUndefined();
    expect(formatRecord({ ...row, record: "{}" }).selfLabels).toBeUndefined();
  });
});

describe("self-label views", () => {
  it("exposes declarations on get/list/pipeline/feed/search independent of external selection", async () => {
    for (const labels of [
      undefined,
      { sources: [{ did: "did:plc:external" }], defaults: [] },
    ]) {
      const { app } = await setup(labels);
      for (const path of [
        "event.listRecords",
        "event.custom",
        `getFeed?feed=network&actor=${actor}`,
        ...(hasFts ? ["event.listRecords?search=Sensitive"] : []),
      ]) {
        const { body, response } = await json(app, path);
        expect(body.records).toHaveLength(1);
        expect(body.records[0].selfLabels).toEqual([{ val: "nudity" }]);
        expect(body.records[0].labels).toBeUndefined();
        expect(response.headers.get("atproto-content-labelers")).toBeNull();
      }
      const { body } = await json(
        app,
        `event.getRecord?uri=${encodeURIComponent(uri)}`,
      );
      expect(body.selfLabels).toEqual([{ val: "nudity" }]);
    }
  });
  it("retains both external and author labels without extra read queries", async () => {
    const external = "did:plc:external";
    const { db, config, app } = await setup({ sources: [{ did: external }] });
    await applyLabels(db, [
      { src: external, uri, val: "porn", cts: new Date().toISOString() },
    ]);
    const prepare = vi.spyOn(db, "prepare");
    const before = await json(app, "event.listRecords");
    const queryCount = prepare.mock.calls.length;
    expect(before.body.records[0]).toMatchObject({
      selfLabels: [{ val: "nudity" }],
      labels: [{ val: "porn" }],
    });
    await ingestRecords(
      db,
      [
        makeEvent({
          cid: "cid2",
          time_us: 2000000,
          operation: "update",
          record: { name: "Sensitive event" },
        }),
      ],
      config,
    );
    prepare.mockClear();
    const after = await json(app, "event.listRecords");
    expect(after.body.records[0].selfLabels).toBeUndefined();
    expect(prepare.mock.calls.length).toBe(queryCount);
    prepare.mockRestore();
  });
  it("normalizes relation/reference previews without inheriting parent warnings", async () => {
    const { db, config, app } = await setup();
    const rsvpUri = `at://did:plc:child/community.lexicon.calendar.rsvp/r1`;
    await ingestRecords(
      db,
      [
        makeEvent({
          did: "did:plc:child",
          uri: rsvpUri,
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: {
            subject: { uri },
            status: "community.lexicon.calendar.rsvp#going",
            labels: declarations("graphic-media"),
          },
        }),
      ],
      config,
    );
    const parent = (await json(app, "event.listRecords?hydrateRsvps=5")).body
      .records[0];
    expect(parent.selfLabels).toEqual([{ val: "nudity" }]);
    expect(parent.rsvps.going[0].selfLabels).toEqual([
      { val: "graphic-media" },
    ]);
    const child = (await json(app, "rsvp.listRecords?hydrateEvent=true")).body
      .records[0];
    expect(child.selfLabels).toEqual([{ val: "graphic-media" }]);
    expect(child.event.selfLabels).toEqual([{ val: "nudity" }]);
  });
  it("shares normalization between cached/fetched profiles without propagating it to posts", async () => {
    const { db, config, app } = await setup(undefined, true);
    const value = {
      $type: profileCollection,
      displayName: "Sensitive profile",
      labels: declarations("sexual"),
    };
    const fetchSpy = vi.fn(async () =>
      Response.json({
        uri: `at://${actor}/${profileCollection}/self`,
        cid: "profilecid",
        value,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const fetched = await resolveProfiles(db, config, [actor]);
    expect(fetched[actor][0].selfLabels).toEqual([{ val: "sexual" }]);
    const cached = await resolveProfiles(db, config, [actor]);
    expect(cached[actor][0].selfLabels).toEqual(fetched[actor][0].selfLabels);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { body } = await json(app, "event.listRecords?profiles=true");
    expect(body.records[0].selfLabels).toEqual([{ val: "nudity" }]);
    expect(body.profiles[0].selfLabels).toEqual([{ val: "sexual" }]);
    // getProfile's PDS refresh uses the same canonical declaration format.
    expect(
      (await json(app, `getProfile?actor=${actor}`)).body.profiles[0]
        .selfLabels,
    ).toEqual([{ val: "sexual" }]);
  });
  it("keeps declarations independent across profile collections and identity-only fallbacks", async () => {
    const { db, config } = await setup(undefined, true);
    const otherCollection = "com.example.otherProfile";
    const multiple = resolveConfig({
      ...config,
      profiles: [
        ...config.profiles!,
        { collection: otherCollection, shortName: "otherProfile" },
      ],
      collections: {
        ...config.collections,
        otherProfile: { collection: otherCollection },
      },
    });
    await initSchema(db, multiple);
    await ingestRecords(
      db,
      [
        makeEvent({
          collection: profileCollection,
          uri: `at://${actor}/${profileCollection}/self`,
          rkey: "self",
          record: { labels: declarations("sexual") },
        }),
        makeEvent({
          collection: otherCollection,
          uri: `at://${actor}/${otherCollection}/self`,
          rkey: "self",
          record: { labels: declarations("graphic-media") },
        }),
      ],
      multiple,
    );
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const profiles = await resolveProfiles(db, multiple, [actor]);
    expect(profiles[actor].map((p) => [p.collection, p.selfLabels])).toEqual([
      [profileCollection, [{ val: "sexual" }]],
      [otherCollection, [{ val: "graphic-media" }]],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const emptyActor = "did:plc:empty";
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(emptyActor, "empty.example", "https://pds.example.com", Date.now())
      .run();
    const fallback = await resolveProfiles(db, multiple, [emptyActor]);
    expect(fallback[emptyActor]).toEqual([
      { did: emptyActor, handle: "empty.example" },
    ]);
  });
  it("removes declarations from deleted records without changing relation counts", async () => {
    const { db, config, app } = await setup();
    const child = makeEvent({
      uri: `at://${actor}/community.lexicon.calendar.rsvp/r1`,
      collection: "community.lexicon.calendar.rsvp",
      rkey: "r1",
      record: {
        subject: { uri },
        status: "community.lexicon.calendar.rsvp#going",
        labels: declarations("!hide"),
      },
    });
    await ingestRecords(db, [child], config);
    expect(
      (await json(app, "event.listRecords")).body.records[0].rsvpsCount,
    ).toBe(1);
    expect(
      (await json(app, "rsvp.listRecords")).body.records[0].selfLabels,
    ).toEqual([{ val: "!hide" }]);
    await ingestRecords(
      db,
      [
        {
          ...child,
          operation: "delete",
          record: null,
          time_us: child.time_us + 1,
        },
      ],
      config,
    );
    expect((await json(app, "rsvp.listRecords")).body.records).toEqual([]);
    expect(
      (await json(app, "event.listRecords")).body.records[0].rsvpsCount ?? 0,
    ).toBe(0);
  });
  it("author hides never enforce; current declarations disappear on update and trusted hides still enforce", async () => {
    const { db, config, app } = await setup(undefined, false, true);
    const update = (value: unknown, time: number) =>
      ingestRecords(
        db,
        [
          makeEvent({
            operation: "update",
            time_us: time,
            cid: `cid${time}`,
            record: value,
          }),
        ],
        config,
      );
    await update({ labels: declarations("!hide", "!takedown") }, 2000000);
    const { body } = await json(app, "event.listRecords");
    expect(body.records).toHaveLength(1);
    expect(body.records[0].selfLabels).toEqual([
      { val: "!hide" },
      { val: "!takedown" },
    ]);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM moderation_hidden")
        .first<any>())!.n,
    ).toBe(0);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM labels").first<any>())!.n,
    ).toBe(0);
    await update({ labels: declarations("porn") }, 3000000);
    expect(
      (await json(app, "event.listRecords")).body.records[0].selfLabels,
    ).toEqual([{ val: "porn" }]);
    await update({}, 4000000);
    expect(
      (await json(app, "event.listRecords")).body.records[0].selfLabels,
    ).toBeUndefined();
    await ingestRecords(
      db,
      [
        createIngestEvent({
          did: "did:plc:moderator",
          collection: MODERATION_ACTION_NSID,
          rkey: "hide",
          operation: "create",
          cid: "actioncid",
          value: {
            subject: uri,
            action: "!hide",
            createdAt: new Date().toISOString(),
          },
          timeUs: 5000000,
        }),
      ],
      config,
    );
    expect(
      (
        await app.request(
          `/xrpc/com.example.event.getRecord?uri=${encodeURIComponent(uri)}`,
        )
      ).status,
    ).toBe(404);
    expect((await json(app, "event.listRecords")).body.records).toEqual([]);
  });
});
