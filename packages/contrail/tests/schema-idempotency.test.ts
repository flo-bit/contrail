import { describe, it, expect } from "vitest";
import { initSchema, addColumnIfNotExists } from "../src/index";
import type { Database } from "../src/index";
import { resolveConfig } from "../src/index";
import { createTestDb, TEST_CONFIG } from "./helpers";

/**
 * L3 — schema idempotency.
 *
 * These tests pin the contract that `initSchema` is safe to call repeatedly
 * (sequentially or concurrently) and that real DDL errors are NOT silently
 * swallowed. The previous implementation wrapped ALTER TABLE statements in
 * `try { ... } catch { /* ignore *\/ }` blocks that masked syntax errors,
 * missing tables, and type mismatches alongside the intended duplicate-column
 * case. After L3, only duplicate-column races are absorbed (via dialect-aware
 * IF-NOT-EXISTS / PRAGMA pre-check); other DDL failures surface.
 */

describe("initSchema idempotency", () => {
  it("is safe to call twice sequentially", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);
    await expect(initSchema(db, TEST_CONFIG)).resolves.not.toThrow();
  });

  it("is safe to call concurrently", async () => {
    const db = createTestDb();
    await Promise.all([
      initSchema(db, TEST_CONFIG),
      initSchema(db, TEST_CONFIG),
      initSchema(db, TEST_CONFIG),
    ]);

    // Verify count column on records_event exists exactly once. The count
    // columns are added via ALTER TABLE; duplicate adds would have failed
    // without idempotent ALTER.
    const cols = await db
      .prepare("PRAGMA table_info(records_event)")
      .all<{ name: string }>();
    const names = cols.results.map((c) => c.name);

    // There should be exactly one of each grouped-count column (sanity check
    // that no parallel run got further than the first).
    const countCols = names.filter((n) => n.startsWith("count_"));
    const dedup = new Set(countCols);
    expect(countCols.length).toBe(dedup.size);
    // And we should have at least one count column (config defines rsvp groups).
    expect(countCols.length).toBeGreaterThan(0);
  });

  it("does not leave duplicate count columns after repeated init", async () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) {
      await initSchema(db, TEST_CONFIG);
    }
    const cols = await db
      .prepare("PRAGMA table_info(records_event)")
      .all<{ name: string }>();
    const names = cols.results.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("addColumnIfNotExists", () => {
  // The helper is the seam where dialect-aware idempotent ALTER lives. We
  // verify it both adds a column when absent and is a no-op when present.
  it("adds the column when absent", async () => {
    const db = createTestDb();
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY)").run();

    await addColumnIfNotExists(db, "t", "extra", "INTEGER NOT NULL DEFAULT 0");

    const cols = await db.prepare("PRAGMA table_info(t)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("extra");
  });

  it("is a no-op when the column already exists", async () => {
    const db = createTestDb();
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, extra INTEGER)").run();

    // First call: column already present — should not throw.
    await expect(
      addColumnIfNotExists(db, "t", "extra", "INTEGER NOT NULL DEFAULT 0")
    ).resolves.not.toThrow();

    // Calling it again should still be a no-op.
    await expect(
      addColumnIfNotExists(db, "t", "extra", "INTEGER NOT NULL DEFAULT 0")
    ).resolves.not.toThrow();

    // And we still have exactly one `extra` column.
    const cols = await db.prepare("PRAGMA table_info(t)").all<{ name: string }>();
    const extras = cols.results.filter((c) => c.name === "extra");
    expect(extras.length).toBe(1);
  });

  it("surfaces real DDL errors (target table does not exist)", async () => {
    // The previous swallow-all `try { ... } catch { /* ignore */ }` masked
    // *any* DDL failure, including target-table-missing. The new helper must
    // only absorb the duplicate-column case and surface everything else.
    const db = createTestDb();

    await expect(
      addColumnIfNotExists(db, "no_such_table", "x", "INTEGER")
    ).rejects.toThrow();
  });
});

describe("initSchema with extra schemas — real DDL errors surface", () => {
  // Belt-and-suspenders: confirm that a genuine failure inside an extension
  // schema module propagates rather than being absorbed. This is the
  // user-visible behavior change from L3.
  it("propagates errors thrown from an extra schema", async () => {
    const db = createTestDb();
    const broken = async (_db: Database) => {
      throw new Error("synthetic DDL failure");
    };

    await expect(
      initSchema(db, TEST_CONFIG, { extraSchemas: [broken] })
    ).rejects.toThrow("synthetic DDL failure");
  });

  it("treats a config without spaces/labels/feeds the same way (sanity)", async () => {
    // Minimal config with no relations — should still init cleanly twice.
    const minimal = resolveConfig({
      namespace: "com.example",
      collections: {
        foo: {
          collection: "com.example.foo",
          queryable: {},
        },
      },
    });
    const db = createTestDb();
    await initSchema(db, minimal);
    await expect(initSchema(db, minimal)).resolves.not.toThrow();
  });
});
