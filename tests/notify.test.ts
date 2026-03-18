import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Database } from "../src/core/types";
import { createTestDbWithSchema, makeEvent, TEST_CONFIG } from "./helpers";
import { parseAtUri } from "../src/core/router/notify";
import { createApp } from "../src/core/router/index";
import { applyEvents, queryRecords } from "../src/core/db/records";
import type { Hono } from "hono";

let db: Database;
let app: Hono;

beforeEach(async () => {
  db = await createTestDbWithSchema();
  app = createApp(db, TEST_CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseAtUri", () => {
  it("parses a valid AT URI", () => {
    const result = parseAtUri(
      "at://did:plc:abc123/community.lexicon.calendar.event/rkey1"
    );
    expect(result).toEqual({
      did: "did:plc:abc123",
      collection: "community.lexicon.calendar.event",
      rkey: "rkey1",
    });
  });

  it("parses did:web URIs", () => {
    const result = parseAtUri(
      "at://did:web:example.com/app.bsky.feed.post/abc"
    );
    expect(result).toEqual({
      did: "did:web:example.com",
      collection: "app.bsky.feed.post",
      rkey: "abc",
    });
  });

  it("returns null for invalid URIs", () => {
    expect(parseAtUri("")).toBeNull();
    expect(parseAtUri("https://example.com")).toBeNull();
    expect(parseAtUri("at://did:plc:abc")).toBeNull(); // missing collection and rkey
    expect(parseAtUri("at://did:plc:abc/collection")).toBeNull(); // missing rkey
    expect(parseAtUri("at://did:plc:abc/collection/rkey/extra")).toBeNull(); // too many segments
  });
});

describe("POST notifyOfUpdate", () => {
  const endpoint = `/xrpc/${TEST_CONFIG.namespace}.notifyOfUpdate`;

  function mockFetch(
    records: Record<string, { value: unknown; cid: string }>
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        const repo = u.searchParams.get("repo");
        const collection = u.searchParams.get("collection");
        const rkey = u.searchParams.get("rkey");
        const uri = `at://${repo}/${collection}/${rkey}`;

        if (records[uri]) {
          return new Response(JSON.stringify(records[uri]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      })
    );
  }

  /** Seed the identities table so getPDS resolves without hitting slingshot. */
  async function seedIdentity(did: string, pds: string) {
    await db
      .prepare(
        "INSERT OR REPLACE INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)"
      )
      .bind(did, "test.handle", pds, Date.now())
      .run();
  }

  it("returns 400 when no uri provided", async () => {
    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/uri/);
  });

  it("returns 400 when too many URIs", async () => {
    const uris = Array.from({ length: 26 }, (_, i) =>
      `at://did:plc:test/community.lexicon.calendar.event/r${i}`
    );
    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/max 25/);
  });

  it("reports error for invalid AT URI", async () => {
    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: "not-a-valid-uri" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toContain("invalid AT URI: not-a-valid-uri");
    expect(body.indexed).toBe(0);
  });

  it("reports error for untracked collection", async () => {
    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toContain("collection not tracked: app.bsky.feed.post");
  });

  it("fetches and indexes a record from PDS", async () => {
    const did = "did:plc:test";
    const uri = `at://${did}/community.lexicon.calendar.event/evt1`;
    const record = { name: "Test Event", startsAt: "2026-04-01T10:00:00Z" };

    await seedIdentity(did, "https://pds.example.com");
    mockFetch({ [uri]: { value: record, cid: "bafytest" } });

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(1);
    expect(body.deleted).toBe(0);
    expect(body.errors).toBeUndefined();

    // Verify the record is in the database
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].uri).toBe(uri);
    expect(result.records[0].cid).toBe("bafytest");
    expect(JSON.parse(result.records[0].record!)).toEqual(record);
  });

  it("deletes locally when record not found on PDS", async () => {
    const did = "did:plc:test";
    const uri = `at://${did}/community.lexicon.calendar.event/evt1`;

    // Pre-populate a record
    await applyEvents(db, [
      makeEvent({ uri, did, rkey: "evt1", record: { name: "Old" } }),
    ]);

    await seedIdentity(did, "https://pds.example.com");
    mockFetch({}); // PDS returns 404 for everything

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(0);
    expect(body.deleted).toBe(1);

    // Verify the record is gone
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(0);
  });

  it("handles batch of URIs", async () => {
    const did = "did:plc:test";
    const uri1 = `at://${did}/community.lexicon.calendar.event/e1`;
    const uri2 = `at://${did}/community.lexicon.calendar.event/e2`;

    await seedIdentity(did, "https://pds.example.com");
    mockFetch({
      [uri1]: { value: { name: "Event 1" }, cid: "cid1" },
      [uri2]: { value: { name: "Event 2" }, cid: "cid2" },
    });

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [uri1, uri2] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(2);

    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(2);
  });

  it("updates an existing record (upsert)", async () => {
    const did = "did:plc:test";
    const uri = `at://${did}/community.lexicon.calendar.event/evt1`;

    // Insert original
    await applyEvents(db, [
      makeEvent({ uri, did, rkey: "evt1", record: { name: "V1" } }),
    ]);

    await seedIdentity(did, "https://pds.example.com");
    mockFetch({
      [uri]: { value: { name: "V2" }, cid: "newcid" },
    });

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(1);

    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(result.records[0].record!).name).toBe("V2");
    expect(result.records[0].cid).toBe("newcid");
  });

  it("updates counts when notifying about a relation record", async () => {
    const did = "did:plc:test";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;
    const rsvpUri = `at://${did}/community.lexicon.calendar.rsvp/r1`;

    // Insert parent event
    await applyEvents(db, [
      makeEvent({ uri: eventUri, did, rkey: "evt1", record: { name: "Event" } }),
    ]);

    await seedIdentity(did, "https://pds.example.com");
    mockFetch({
      [rsvpUri]: {
        value: { subject: { uri: eventUri }, status: "going" },
        cid: "rsvpcid",
      },
    });

    await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: rsvpUri }),
    });

    // Check that the event now has an RSVP count
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records).toHaveLength(1);
    expect(
      result.records[0].counts?.["community.lexicon.calendar.rsvp"]
    ).toBe(1);
  });

  it("skips when record already exists with same CID (no double-counting)", async () => {
    const did = "did:plc:test";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;
    const rsvpUri = `at://${did}/community.lexicon.calendar.rsvp/r1`;
    const rsvpRecord = { subject: { uri: eventUri }, status: "going" };

    // Insert parent event and RSVP via normal ingestion
    await applyEvents(db, [
      makeEvent({ uri: eventUri, did, rkey: "evt1", record: { name: "Event" } }),
    ]);
    await applyEvents(
      db,
      [
        makeEvent({
          uri: rsvpUri,
          did,
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          cid: "rsvpcid",
          record: rsvpRecord,
          time_us: 2000000,
        }),
      ],
      TEST_CONFIG
    );

    // Verify count is 1
    let result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(1);

    // Now notify with the same RSVP (same CID) — should be a no-op
    await seedIdentity(did, "https://pds.example.com");
    mockFetch({
      [rsvpUri]: { value: rsvpRecord, cid: "rsvpcid" },
    });

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: rsvpUri }),
    });

    const body = await res.json();
    expect(body.indexed).toBe(0); // skipped, nothing changed
    expect(body.deleted).toBe(0);

    // Count should still be 1, not 2
    result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(1);
  });

  it("uses update (not create) when record exists with different CID", async () => {
    const did = "did:plc:test";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;
    const rsvpUri = `at://${did}/community.lexicon.calendar.rsvp/r1`;

    // Insert parent event and RSVP via normal ingestion
    await applyEvents(db, [
      makeEvent({ uri: eventUri, did, rkey: "evt1", record: { name: "Event" } }),
    ]);
    await applyEvents(
      db,
      [
        makeEvent({
          uri: rsvpUri,
          did,
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          cid: "oldcid",
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000000,
        }),
      ],
      TEST_CONFIG
    );

    // Now notify with updated record (different CID)
    await seedIdentity(did, "https://pds.example.com");
    mockFetch({
      [rsvpUri]: {
        value: { subject: { uri: eventUri }, status: "interested" },
        cid: "newcid",
      },
    });

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: rsvpUri }),
    });

    const body = await res.json();
    expect(body.indexed).toBe(1);

    // Record should be updated
    const rsvpResult = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.rsvp",
    });
    expect(rsvpResult.records).toHaveLength(1);
    expect(rsvpResult.records[0].cid).toBe("newcid");

    // Count should still be 1 (not double-counted)
    const result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(1);
  });

  it("does nothing when record not on PDS and not local", async () => {
    const did = "did:plc:test";
    const uri = `at://${did}/community.lexicon.calendar.event/nonexistent`;

    await seedIdentity(did, "https://pds.example.com");
    mockFetch({}); // 404 for everything

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri }),
    });

    const body = await res.json();
    expect(body.indexed).toBe(0);
    expect(body.deleted).toBe(0);
  });

  it("decrements counts when deleting a relation record", async () => {
    const did = "did:plc:test";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;
    const rsvpUri = `at://${did}/community.lexicon.calendar.rsvp/r1`;

    // Insert event + RSVP
    await applyEvents(db, [
      makeEvent({ uri: eventUri, did, rkey: "evt1", record: { name: "Event" } }),
    ]);
    await applyEvents(
      db,
      [
        makeEvent({
          uri: rsvpUri,
          did,
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000000,
        }),
      ],
      TEST_CONFIG
    );

    // Verify count is 1
    let result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(1);

    // Notify with RSVP URI — PDS returns 404 (deleted)
    await seedIdentity(did, "https://pds.example.com");
    mockFetch({});

    const res = await app.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: rsvpUri }),
    });

    const body = await res.json();
    expect(body.deleted).toBe(1);

    // Count should be back to 0
    result = await queryRecords(db, TEST_CONFIG, {
      collection: "community.lexicon.calendar.event",
    });
    expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"] ?? 0).toBe(0);
  });
});
