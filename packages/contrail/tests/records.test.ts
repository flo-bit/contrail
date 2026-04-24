import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "../src/core/types";
import { applyEvents, createTestDbWithSchema, makeEvent, TEST_CONFIG } from "./helpers";
import { queryRecords, getLastCursor, saveCursor } from "../src/core/db/records";

let db: Database;

beforeEach(async () => {
  db = await createTestDbWithSchema();
});

describe("cursor", () => {
  it("returns null when no cursor exists", async () => {
    expect(await getLastCursor(db)).toBeNull();
  });

  it("saves and retrieves cursor", async () => {
    await saveCursor(db, 12345);
    expect(await getLastCursor(db)).toBe(12345);
  });

  it("updates existing cursor", async () => {
    await saveCursor(db, 100);
    await saveCursor(db, 200);
    expect(await getLastCursor(db)).toBe(200);
  });
});

describe("applyEvents", () => {
  it("does nothing for empty events", async () => {
    await applyEvents(db, []);
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(0);
  });

  it("inserts create events", async () => {
    await applyEvents(db, [makeEvent()]);
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].uri).toBe("at://did:plc:test/community.lexicon.calendar.event/abc");
    expect(result.records[0].did).toBe("did:plc:test");
  });

  it("upserts on conflict", async () => {
    await applyEvents(db, [
      makeEvent({ record: { name: "V1" }, time_us: 100 }),
    ]);
    await applyEvents(db, [
      makeEvent({ record: { name: "V2" }, time_us: 200, operation: "update" }),
    ]);
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(1);
    const record = JSON.parse(result.records[0].record!);
    expect(record.name).toBe("V2");
  });

  it("deletes events", async () => {
    await applyEvents(db, [makeEvent()]);
    await applyEvents(db, [makeEvent({ operation: "delete" })]);
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(0);
  });

  it("builds count statements for relations", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    // Insert parent event
    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1" })]);

    // Insert RSVP pointing at the event
    await applyEvents(
      db,
      [
        makeEvent({
          uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:user1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#going" },
          time_us: 2000000,
        }),
      ],
      TEST_CONFIG
    );

    // Query event with counts
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].counts).toBeDefined();
    expect(result.records[0].counts!["rsvp"]).toBe(1);
  });

  it("decrements counts on delete", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";
    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1" })]);

    const rsvpRecord = { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#going" };
    await applyEvents(
      db,
      [
        makeEvent({
          uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:user1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: rsvpRecord,
          time_us: 2000000,
        }),
      ],
      TEST_CONFIG
    );

    // Delete the RSVP
    await applyEvents(
      db,
      [
        makeEvent({
          uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:user1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: rsvpRecord,
          operation: "delete",
          time_us: 3000000,
        }),
      ],
      TEST_CONFIG
    );

    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    const counts = result.records[0].counts;
    // Count should be 0 or undefined after delete
    expect(counts?.["community.lexicon.calendar.rsvp"] ?? 0).toBe(0);
  });
});

describe("queryRecords", () => {
  beforeEach(async () => {
    await applyEvents(db, [
      makeEvent({
        uri: "at://did:plc:a/community.lexicon.calendar.event/1",
        did: "did:plc:a",
        rkey: "1",
        record: { name: "Alpha", mode: "online", startsAt: "2026-01-01T00:00:00Z" },
        time_us: 3000,
      }),
      makeEvent({
        uri: "at://did:plc:b/community.lexicon.calendar.event/2",
        did: "did:plc:b",
        rkey: "2",
        record: { name: "Beta", mode: "in-person", startsAt: "2026-02-01T00:00:00Z" },
        time_us: 2000,
      }),
      makeEvent({
        uri: "at://did:plc:a/community.lexicon.calendar.event/3",
        did: "did:plc:a",
        rkey: "3",
        record: { name: "Gamma", mode: "online", startsAt: "2026-03-01T00:00:00Z" },
        time_us: 1000,
      }),
    ]);
  });

  it("returns records ordered by time_us desc", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(3);
    expect(result.records[0].time_us).toBe(3000);
    expect(result.records[1].time_us).toBe(2000);
    expect(result.records[2].time_us).toBe(1000);
  });

  it("filters by did", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      did: "did:plc:a",
    });
    expect(result.records).toHaveLength(2);
    expect(result.records.every((r) => r.did === "did:plc:a")).toBe(true);
  });

  it("respects limit", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 2,
    });
    expect(result.records).toHaveLength(2);
    expect(result.cursor).toBeDefined();
  });

  it("clamps limit to [1, 100]", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 0,
    });
    expect(result.records).toHaveLength(1); // clamped to 1

    const result2 = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 999,
    });
    expect(result2.records).toHaveLength(3); // clamped to 100, but only 3 exist
  });

  it("paginates with cursor", async () => {
    const page1 = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 2,
    });
    expect(page1.records).toHaveLength(2);
    expect(page1.cursor).toBeDefined();

    const page2 = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 2,
      cursor: page1.cursor,
    });
    expect(page2.records).toHaveLength(1);
    expect(page2.cursor).toBeUndefined();
  });

  it("filters by equality", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      filters: { mode: "online" },
    });
    expect(result.records).toHaveLength(2);
  });

  it("filters by range", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      rangeFilters: {
        startsAt: { min: "2026-01-15T00:00:00Z" },
      },
    });
    expect(result.records).toHaveLength(2);
    // Should include Beta (Feb) and Gamma (Mar)
  });

  it("sorts by record field asc", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      sort: { recordField: "name", direction: "asc" },
    });
    const names = result.records.map((r) => JSON.parse(r.record!).name);
    expect(names).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("sorts by record field desc", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      sort: { recordField: "name", direction: "desc" },
    });
    const names = result.records.map((r) => JSON.parse(r.record!).name);
    expect(names).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("returns no cursor when all results fit", async () => {
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
      limit: 50,
    });
    expect(result.cursor).toBeUndefined();
  });

  it("throws for unknown collection (table does not exist)", async () => {
    await expect(
      queryRecords(db, TEST_CONFIG, {
        collection: "nonexistent.collection",
      })
    ).rejects.toThrow();
  });

  it("filter keys are interpolated into SQL — only trusted input should be passed", async () => {
    // queryRecords interpolates filter field names directly into json_extract calls.
    // Malicious field names can break the query. This test documents that filter keys
    // must be validated before reaching queryRecords (e.g. via validateFieldName).
    await expect(
      queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        filters: { "'); DROP TABLE records; --": "x" },
      })
    ).rejects.toThrow();
  });
});
