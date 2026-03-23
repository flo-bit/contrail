import { describe, it, expect, beforeEach } from "vitest";
import type { Database, RecordRow, RelationConfig, ReferenceConfig } from "../src/core/types";
import { recordsTableName } from "../src/core/types";
import { parseHydrateParams, resolveHydrates, resolveReferences } from "../src/core/router/hydrate";
import { createTestDbWithSchema, makeEvent, TEST_CONFIG } from "./helpers";
import { applyEvents } from "../src/core/db/records";

describe("parseHydrateParams", () => {
  const relations: Record<string, RelationConfig> = {
    rsvps: { collection: "community.lexicon.calendar.rsvp", groupBy: "status" },
    comments: { collection: "test.comment" },
  };
  const references: Record<string, ReferenceConfig> = {
    event: { collection: "community.lexicon.calendar.event", field: "subject.uri" },
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
    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 5 }, []);
    expect(result).toEqual({});
  });

  it("hydrates related records", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    // Insert event
    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    // Insert RSVPs
    for (let i = 0; i < 3; i++) {
      await applyEvents(db, [
        makeEvent({
          uri: `at://did:plc:user${i}/community.lexicon.calendar.rsvp/r${i}`,
          did: `did:plc:user${i}`,
          collection: "community.lexicon.calendar.rsvp",
          rkey: `r${i}`,
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000 + i,
        }),
      ]);
    }

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("community.lexicon.calendar.event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri]).toBeDefined();
    expect(result[eventUri].rsvps).toBeDefined();
    expect(result[eventUri].rsvps["going"]).toHaveLength(3);
  });

  it("respects hydrate limit", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";
    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    for (let i = 0; i < 5; i++) {
      await applyEvents(db, [
        makeEvent({
          uri: `at://did:plc:user${i}/community.lexicon.calendar.rsvp/r${i}`,
          did: `did:plc:user${i}`,
          collection: "community.lexicon.calendar.rsvp",
          rkey: `r${i}`,
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000 + i,
        }),
      ]);
    }

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("community.lexicon.calendar.event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 2 }, [eventRow!]);

    expect(result[eventUri].rsvps["going"].length).toBeLessThanOrEqual(2);
  });

  it("hydrates with match: 'did'", async () => {
    const did = "did:plc:shareduser";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;

    // Insert event owned by this DID
    await applyEvents(db, [makeEvent({ uri: eventUri, did, rkey: "evt1", time_us: 1000 })]);

    // Insert a related record whose "author" field contains the parent's DID
    await applyEvents(db, [
      makeEvent({
        uri: `at://did:plc:other/community.lexicon.calendar.rsvp/r1`,
        did: "did:plc:other",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r1",
        record: { author: did, status: "going" },
        time_us: 2000,
      }),
    ]);

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("community.lexicon.calendar.event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    // match: "did" means matchValues are parent DIDs, and field points to where the DID is stored
    const relations: Record<string, RelationConfig> = {
      rsvps: { collection: "community.lexicon.calendar.rsvp", match: "did", field: "author", groupBy: "status" },
    };
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri]).toBeDefined();
    expect(result[eventUri].rsvps).toBeDefined();
    expect(result[eventUri].rsvps["going"]).toHaveLength(1);
  });

  it("resolves reference: event onto rsvp (child→parent via subject.uri)", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    // Insert event
    await applyEvents(db, [
      makeEvent({ uri: eventUri, rkey: "evt1", record: { name: "My Event" }, time_us: 1000 }),
    ]);

    // Insert RSVP pointing at the event
    const rsvpUri = "at://did:plc:user1/community.lexicon.calendar.rsvp/r1";
    await applyEvents(db, [
      makeEvent({
        uri: rsvpUri,
        did: "did:plc:user1",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri }, status: "going" },
        time_us: 2000,
      }),
    ]);

    const rsvpRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("community.lexicon.calendar.rsvp")} WHERE uri = ?`)
      .bind(rsvpUri)
      .first<RecordRow>();

    const references = TEST_CONFIG.collections["community.lexicon.calendar.rsvp"].references!;
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
    await applyEvents(db, [
      makeEvent({ uri: eventUri1, rkey: "evt1", record: { name: "Event 1" }, time_us: 1000 }),
      makeEvent({ uri: eventUri2, rkey: "evt2", record: { name: "Event 2" }, time_us: 1001 }),
    ]);

    // Insert RSVPs pointing at different events
    const rsvpUri1 = "at://did:plc:user1/community.lexicon.calendar.rsvp/r1";
    const rsvpUri2 = "at://did:plc:user2/community.lexicon.calendar.rsvp/r2";
    await applyEvents(db, [
      makeEvent({
        uri: rsvpUri1,
        did: "did:plc:user1",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri1 }, status: "going" },
        time_us: 2000,
      }),
      makeEvent({
        uri: rsvpUri2,
        did: "did:plc:user2",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r2",
        record: { subject: { uri: eventUri2 }, status: "interested" },
        time_us: 2001,
      }),
    ]);

    const rsvpRows = await db
      .prepare(`SELECT * FROM ${recordsTableName("community.lexicon.calendar.rsvp")} ORDER BY time_us DESC`)
      .all<RecordRow>();

    const references = TEST_CONFIG.collections["community.lexicon.calendar.rsvp"].references!;
    const result = await resolveReferences(db, references, new Set(["event"]), rsvpRows.results!);

    // Each RSVP should have its event resolved
    expect(result[rsvpUri1]?.event).toBeDefined();
    expect(result[rsvpUri2]?.event).toBeDefined();
    expect(result[rsvpUri1].event.uri).toBe(eventUri1);
    expect(result[rsvpUri2].event.uri).toBe(eventUri2);
  });

  it("groups into 'other' when groupBy value is null", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    // Insert RSVP without a status field — groupBy "status" should fall back to "other"
    await applyEvents(db, [
      makeEvent({
        uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
        did: "did:plc:user1",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri } },
        time_us: 2000,
      }),
    ]);

    const eventRow = await db
      .prepare(`SELECT * FROM ${recordsTableName("community.lexicon.calendar.event")} WHERE uri = ?`)
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri].rsvps).toBeDefined();
    expect(result[eventUri].rsvps["other"]).toHaveLength(1);
  });
});
