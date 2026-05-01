import { describe, it, expect } from "vitest";
import { initSchema } from "../src/core/db/schema";
import { initCommunitySchema } from "../src/core/community/schema";
import { resolveConfig } from "../src/core/types";
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
      "custody_mode",
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

describe("communities table migration (custody_mode)", () => {
  it("adds custody_mode column when upgrading from pre-PR shape", async () => {
    // Simulate an existing prod deployment: communities table from BEFORE
    // this PR (no custody_mode column). The CREATE IF NOT EXISTS in the new
    // schema will short-circuit on this existing table — only the migration
    // can add the column.
    const db = createTestDb();
    await db
      .prepare(
        `CREATE TABLE communities (
          did TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          pds_endpoint TEXT,
          app_password_encrypted TEXT,
          identifier TEXT,
          signing_key_encrypted TEXT,
          rotation_key_encrypted TEXT,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER
        )`
      )
      .run();
    await db
      .prepare(
        "INSERT INTO communities (did, mode, created_by, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind("did:plc:legacy", "owned", "did:plc:owner", 1000)
      .run();

    // Run the full schema init (the path real deployments take on upgrade).
    // initSchema only runs the community migration when config.community is
    // set, so include a minimal community config.
    const upgradeConfig = resolveConfig({
      ...TEST_CONFIG,
      community: { masterKey: new Uint8Array(32) },
    });
    await initSchema(db, upgradeConfig);

    const cols = await db
      .prepare("PRAGMA table_info(communities)")
      .all<{ name: string }>();
    const colNames = cols.results.map((c) => c.name);
    expect(colNames).toContain("custody_mode");

    // Existing row still readable; new column reads as NULL.
    const legacy = await db
      .prepare("SELECT custody_mode FROM communities WHERE did = ?")
      .bind("did:plc:legacy")
      .first<{ custody_mode: string | null }>();
    expect(legacy?.custody_mode).toBeNull();

    // New rows can write to custody_mode.
    await db
      .prepare(
        "INSERT INTO communities (did, mode, custody_mode, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind("did:plc:fresh", "owned", "self_sovereign", "did:plc:owner", 2000)
      .run();
    const fresh = await db
      .prepare("SELECT custody_mode FROM communities WHERE did = ?")
      .bind("did:plc:fresh")
      .first<{ custody_mode: string }>();
    expect(fresh?.custody_mode).toBe("self_sovereign");
  });
});
