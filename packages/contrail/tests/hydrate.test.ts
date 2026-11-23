import { describe, it, expect, beforeEach } from "vitest";
import type { Database, RecordRow, RelationConfig, ReferenceConfig } from "../src/index";
import {
  createApp,
  ingestRecords as coreIngestRecords,
  initSchema,
  recordsTableName,
  resolveConfig,
  parseHydrateParams,
  resolveHydrates,
  resolveReferences,
} from "../src/index";
import { createTestDb, createTestDbWithSchema, makeEvent, TEST_CONFIG } from "./helpers";
import { ingestRecords } from "./helpers";

describe("parseHydrateParams", () => {
  const relations: Record<string, RelationConfig> = {
    rsvps: { collection: "rsvp", groupBy: "status" },
    comments: { collection: "test.comment" },
  };
  const references: Record<string, ReferenceConfig> = {
    event: { collection: "event", field: "subject.uri" },
  };

  it("parses valid relation hydrate params", () => {
    const params = new URLSearchParams({ hydrateRsvps: "5", hydrateComments: "3" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.relations).toEqual({ rsvps: 5, comments: 3 });
    expect(result.references.size).toBe(0);
  });

  it("parses valid reference hydrate params", () => {
    const params = new URLSearchParams({ hydrateEvent: "true" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.relations).toEqual({});
    expect(result.references.has("event")).toBe(true);
  });

  it("parses reference hydrate with 1", () => {
    const params = new URLSearchParams({ hydrateEvent: "1" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.references.has("event")).toBe(true);
  });

  it("ignores unrelated params", () => {
    const params = new URLSearchParams({ hydrateFoo: "5", limit: "10" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.relations).toEqual({});
    expect(result.references.size).toBe(0);
  });

  it("ignores invalid numbers", () => {
    const params = new URLSearchParams({ hydrateRsvps: "abc" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.relations).toEqual({});
  });

  it("ignores zero and negative", () => {
    const params = new URLSearchParams({ hydrateRsvps: "0", hydrateComments: "-1" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.relations).toEqual({});
  });

  it("returns empty for no hydrate params", () => {
    const params = new URLSearchParams({ limit: "50" });
    const result = parseHydrateParams(params, relations, references);
    expect(result.relations).toEqual({});
    expect(result.references.size).toBe(0);
  });
});

describe("resolveHydrates", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDbWithSchema();
  });

  it("returns empty when no hydrations requested", async () => {
    const result = await resolveHydrates(db, {}, {}, []);
    expect(result).toEqual({});
  });

  it("returns empty when no records", async () => {
    const relations = TEST_CONFIG.collections["event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 5 }, []);
    expect(result).toEqual({});
  });

  it("maps grouped Lexicon tokens to their configured short names", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    // Insert event
    await ingestRecords(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    // Insert RSVPs using the full token stored in real Lexicon records.
    for (let i = 0; i < 3; i++) {
      await ingestRecords(db, [
        makeEvent({
          uri: `at://did:plc:user${i}/community.lexicon.calendar.rsvp/r${i}`,
          did: `did:plc:user${i}`,
          collection: "rsvp",
          rkey: `r${i}`,
          record: {
            subject: { uri: eventUri },
            status: "community.lexicon.calendar.rsvp#going",
          },
          time_us: 2000 + i,
        }),
      ]);
    }

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri]).toBeDefined();
    expect(result[eventUri].rsvps).toBeDefined();
    expect((result[eventUri].rsvps as Record<string, any[]>)["going"]).toHaveLength(3);
  });

  it("respects hydrate limit", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";
    await ingestRecords(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    for (let i = 0; i < 5; i++) {
      await ingestRecords(db, [
        makeEvent({
          uri: `at://did:plc:user${i}/community.lexicon.calendar.rsvp/r${i}`,
          did: `did:plc:user${i}`,
          collection: "rsvp",
          rkey: `r${i}`,
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000 + i,
        }),
      ]);
    }

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 2 }, [eventRow!]);

    expect((result[eventUri].rsvps as Record<string, any[]>)["going"].length).toBeLessThanOrEqual(2);
  });

  it("hydrates with match: 'did'", async () => {
    const did = "did:plc:shareduser";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;

    // Insert event owned by this DID
    await ingestRecords(db, [makeEvent({ uri: eventUri, did, rkey: "evt1", time_us: 1000 })]);

    // Insert a related record whose "author" field contains the parent's DID
    await ingestRecords(db, [
      makeEvent({
        uri: `at://did:plc:other/community.lexicon.calendar.rsvp/r1`,
        did: "did:plc:other",
        collection: "rsvp",
        rkey: "r1",
        record: { author: did, status: "going" },
        time_us: 2000,
      }),
    ]);

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    // match: "did" means matchValues are parent DIDs, and field points to where the DID is stored
    const relations: Record<string, RelationConfig> = {
      rsvps: { collection: "rsvp", match: "did", field: "author", groupBy: "status" },
    };
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri]).toBeDefined();
    expect(result[eventUri].rsvps).toBeDefined();
    expect((result[eventUri].rsvps as Record<string, any[]>)["going"]).toHaveLength(1);
  });

  it("resolves reference: event onto rsvp (child→parent via subject.uri)", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    // Insert event
    await ingestRecords(db, [
      makeEvent({ uri: eventUri, rkey: "evt1", record: { name: "My Event" }, time_us: 1000 }),
    ]);

    // Insert RSVP pointing at the event
    const rsvpUri = "at://did:plc:user1/community.lexicon.calendar.rsvp/r1";
    await ingestRecords(db, [
      makeEvent({
        uri: rsvpUri,
        did: "did:plc:user1",
        collection: "rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri }, status: "going" },
        time_us: 2000,
      }),
    ]);

    const rsvpRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("rsvp")} WHERE uri = ?`)
      .bind(rsvpUri)
      .first<RecordRow>();

    const references = TEST_CONFIG.collections["rsvp"].references!;
    const result = await resolveReferences(db, references, new Set(["event"]), [rsvpRow!]);

    expect(result[rsvpUri]).toBeDefined();
    expect(result[rsvpUri].event).toBeDefined();
    // reference returns a single object, not an array
    expect(result[rsvpUri].event.uri).toBe(eventUri);
  });

  it("resolves references onto multiple rsvps", async () => {
    const eventUri1 = "at://did:plc:test/community.lexicon.calendar.event/evt1";
    const eventUri2 = "at://did:plc:test/community.lexicon.calendar.event/evt2";

    // Insert two events
    await ingestRecords(db, [
      makeEvent({ uri: eventUri1, rkey: "evt1", record: { name: "Event 1" }, time_us: 1000 }),
      makeEvent({ uri: eventUri2, rkey: "evt2", record: { name: "Event 2" }, time_us: 1001 }),
    ]);

    // Insert RSVPs pointing at different events
    const rsvpUri1 = "at://did:plc:user1/community.lexicon.calendar.rsvp/r1";
    const rsvpUri2 = "at://did:plc:user2/community.lexicon.calendar.rsvp/r2";
    await ingestRecords(db, [
      makeEvent({
        uri: rsvpUri1,
        did: "did:plc:user1",
        collection: "rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri1 }, status: "going" },
        time_us: 2000,
      }),
      makeEvent({
        uri: rsvpUri2,
        did: "did:plc:user2",
        collection: "rsvp",
        rkey: "r2",
        record: { subject: { uri: eventUri2 }, status: "interested" },
        time_us: 2001,
      }),
    ]);

    const rsvpRows = await db
      .prepare(`SELECT * FROM ${recordsTableName("rsvp")} ORDER BY time_us DESC`)
      .all<RecordRow>();

    const references = TEST_CONFIG.collections["rsvp"].references!;
    const result = await resolveReferences(db, references, new Set(["event"]), rsvpRows.results!);

    // Each RSVP should have its event resolved
    expect(result[rsvpUri1]?.event).toBeDefined();
    expect(result[rsvpUri2]?.event).toBeDefined();
    expect(result[rsvpUri1].event.uri).toBe(eventUri1);
    expect(result[rsvpUri2].event.uri).toBe(eventUri2);
  });

  it("groups into 'other' when groupBy value is null", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    await ingestRecords(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    // Insert RSVP without a status field — groupBy "status" should fall back to "other"
    await ingestRecords(db, [
      makeEvent({
        uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
        did: "did:plc:user1",
        collection: "rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri } },
        time_us: 2000,
      }),
    ]);

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri].rsvps).toBeDefined();
    expect((result[eventUri].rsvps as Record<string, any[]>)["other"]).toHaveLength(1);
  });

  it("does not let one popular parent starve other parents in the same hydrate batch", async () => {
    const popularUri = "at://did:plc:test/community.lexicon.calendar.event/popular";
    const quietUri = "at://did:plc:test/community.lexicon.calendar.event/quiet";
    await ingestRecords(db, [
      makeEvent({ uri: popularUri, rkey: "popular", time_us: 1000 }),
      makeEvent({ uri: quietUri, rkey: "quiet", time_us: 1001 }),
    ]);

    // Older RSVPs on the quiet parent, followed by 50 newer RSVPs on the popular parent.
    const rsvps = [
      makeEvent({
        uri: "at://did:plc:q1/community.lexicon.calendar.rsvp/q1",
        did: "did:plc:q1",
        collection: "rsvp",
        rkey: "q1",
        record: { subject: { uri: quietUri }, status: "going" },
        time_us: 2000,
      }),
      makeEvent({
        uri: "at://did:plc:q2/community.lexicon.calendar.rsvp/q2",
        did: "did:plc:q2",
        collection: "rsvp",
        rkey: "q2",
        record: { subject: { uri: quietUri }, status: "going" },
        time_us: 2001,
      }),
      ...Array.from({ length: 50 }, (_, i) =>
        makeEvent({
          uri: `at://did:plc:p${i}/community.lexicon.calendar.rsvp/p${i}`,
          did: `did:plc:p${i}`,
          collection: "rsvp",
          rkey: `p${i}`,
          record: { subject: { uri: popularUri }, status: "going" },
          time_us: 5000 + i,
        }),
      ),
    ];
    await ingestRecords(db, rsvps);

    const eventRows = (
      await db
        .prepare(`SELECT * FROM ${recordsTableName("event")} ORDER BY time_us DESC`)
        .all<RecordRow>()
    ).results;
    const relations = TEST_CONFIG.collections["event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 2 }, eventRows);

    expect(result[popularUri]?.rsvps["going"]).toHaveLength(2);
    expect(result[quietUri]?.rsvps["going"]).toHaveLength(2);
  });

  it("includes hydrated reference authors when profiles=true", async () => {
    const eventAuthor = "did:plc:eventauthoraaaaaaaaaaaa";
    const rsvpAuthor = "did:plc:rsvpauthoraaaaaaaaaaaaa";
    const eventUri = `at://${eventAuthor}/community.lexicon.calendar.event/evt1`;
    const rsvpUri = `at://${rsvpAuthor}/community.lexicon.calendar.rsvp/r1`;

    for (const [did, handle, name] of [
      [eventAuthor, "eventauthor.test", "Event Author"],
      [rsvpAuthor, "rsvpauthor.test", "RSVP Author"],
    ]) {
      await db
        .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
        .bind(did, handle, "https://pds.test", Date.now())
        .run();
      await db
        .prepare(
          `INSERT INTO ${recordsTableName("profile")} (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `at://${did}/app.bsky.actor.profile/self`,
          did,
          "self",
          `cid-${did}`,
          JSON.stringify({ displayName: name }),
          100,
          100,
        )
        .run();
    }

    await ingestRecords(db, [
      makeEvent({ uri: eventUri, did: eventAuthor, rkey: "evt1", time_us: 1000 }),
      makeEvent({
        uri: rsvpUri,
        did: rsvpAuthor,
        collection: "rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri }, status: "going" },
        time_us: 2000,
      }),
    ]);

    const app = createApp(db, TEST_CONFIG);
    const listRes = await app.request(
      "/xrpc/com.example.rsvp.listRecords?hydrateEvent=true&profiles=true",
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.profiles.map((p: any) => p.did).sort()).toEqual(
      [eventAuthor, rsvpAuthor].sort(),
    );

    const getRes = await app.request(
      `/xrpc/com.example.rsvp.getRecord?uri=${encodeURIComponent(rsvpUri)}&hydrateEvent=true&profiles=true`,
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as any;
    expect(getBody.profiles.map((p: any) => p.did).sort()).toEqual(
      [eventAuthor, rsvpAuthor].sort(),
    );
  });

  it("supports JSON-path countDistinct during live count updates", async () => {
    const distinctConfig = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        poll: {
          collection: "com.example.poll",
          relations: {
            votes: {
              collection: "vote",
              field: "pollUri",
              countDistinct: "voter.id",
            },
          },
        },
        vote: {
          collection: "com.example.vote",
        },
      },
    });
    const distinctDb = createTestDb();
    await initSchema(distinctDb, distinctConfig);

    const pollUri = "at://did:plc:host/com.example.poll/p1";
    await coreIngestRecords(
      distinctDb,
      [
        makeEvent({
          uri: pollUri,
          did: "did:plc:host",
          collection: "com.example.poll",
          rkey: "p1",
          record: { question: "Best?" },
          time_us: 1000,
        }),
        makeEvent({
          uri: "at://did:plc:a/com.example.vote/v1",
          did: "did:plc:a",
          collection: "com.example.vote",
          rkey: "v1",
          record: { pollUri, voter: { id: "voter-1" } },
          time_us: 1001,
        }),
        makeEvent({
          uri: "at://did:plc:b/com.example.vote/v2",
          did: "did:plc:b",
          collection: "com.example.vote",
          rkey: "v2",
          record: { pollUri, voter: { id: "voter-1" } },
          time_us: 1002,
        }),
        makeEvent({
          uri: "at://did:plc:c/com.example.vote/v3",
          did: "did:plc:c",
          collection: "com.example.vote",
          rkey: "v3",
          record: { pollUri, voter: { id: "voter-2" } },
          time_us: 1003,
        }),
      ],
      distinctConfig,
    );

    const row = await distinctDb
      .prepare(`SELECT count_vote FROM ${recordsTableName("poll")} WHERE uri = ?`)
      .bind(pollUri)
      .first<{ count_vote: number }>();
    expect(row?.count_vote).toBe(2);
  });
});
