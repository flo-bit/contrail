import { describe, it, expect } from "vitest";
import { initSchema } from "../src/core/db/schema";
import { initCommunitySchema } from "../src/core/community/schema";
import { createTestDb, createTestDbWithSchema, TEST_CONFIG } from "./helpers";

describe("initSchema", () => {
  it("creates all required tables", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((t) => t.name);

    expect(names).toContain("records_event");
    expect(names).toContain("records_rsvp");
    expect(names).toContain("backfills");
    expect(names).toContain("discovery");
    expect(names).toContain("cursor");
    expect(names).toContain("identities");
  });

  it("creates dynamic indexes for queryable fields", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all<{ name: string }>();
    const names = indexes.results.map((i) => i.name);

    // Should have indexes for queryable fields
    expect(names.some((n) => n.includes("mode"))).toBe(true);
    expect(names.some((n) => n.includes("name"))).toBe(true);
    expect(names.some((n) => n.includes("startsAt"))).toBe(true);
  });

  it("creates relation indexes", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all<{ name: string }>();
    const names = indexes.results.map((i) => i.name);

    // Should have index for subject.uri relation field
    expect(names.some((n) => n.includes("subject"))).toBe(true);
  });

  it("is idempotent", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);
    // Running again should not throw
    await initSchema(db, TEST_CONFIG);
  });
});

describe("provision_attempts schema", () => {
  it("creates the table with the expected columns", async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    const cols = await db
      .prepare("PRAGMA table_info(provision_attempts)")
      .all<{ name: string; type: string; notnull: number }>();
    const names = cols.results.map((c) => c.name).sort();
    expect(names).toEqual([
      "account_created_at",
      "activated_at",
      "attempt_id",
      "caller_rotation_did_key",
      "created_at",
      "did",
      "did_doc_updated_at",
      "email",
      "encrypted_password",
      "encrypted_rotation_key",
      "encrypted_signing_key",
      "genesis_submitted_at",
      "handle",
      "invite_code",
      "last_error",
      "pds_endpoint",
      "status",
      "updated_at",
    ]);
  });

  it("enforces status enum", async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    await expect(
      db
        .prepare(
          "INSERT INTO provision_attempts (attempt_id, did, status, created_at, updated_at, pds_endpoint, handle, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("a1", "did:plc:x", "bogus", 1, 1, "https://pds", "h.test", "x@x")
        .run()
    ).rejects.toThrow();
  });
});

describe("community_sessions schema", () => {
  it("creates the cache table", async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    const cols = await db
      .prepare("PRAGMA table_info(community_sessions)")
      .all<{ name: string }>();
    const names = cols.results.map((c) => c.name).sort();
    expect(names).toEqual([
      "access_exp",
      "access_jwt",
      "community_did",
      "refresh_jwt",
      "updated_at",
    ]);
  });
});

