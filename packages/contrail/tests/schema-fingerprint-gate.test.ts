import { describe, it, expect } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema, getMeta } from "../src/core/db";
import { resolveConfig } from "../src/core/types";
import type { Database, Statement } from "../src/core/types";

// initSchema replays ~40 DDL statements serially on every call; on recycled
// Workers isolates that's hundreds of ms of cold-start round-trips. The
// fingerprint gate must skip all of it after a single read when the schema is
// unchanged, and re-apply when it changes.

function recordingDb(real: Database): { db: Database; prepares: string[] } {
  const prepares: string[] = [];
  const db: Database = {
    prepare(sql: string): Statement {
      prepares.push(sql);
      return real.prepare(sql);
    },
    batch(stmts: Statement[]): Promise<any[]> {
      return real.batch(stmts);
    },
    dialect: real.dialect,
  };
  return { db, prepares };
}

const CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { name: {} },
    },
  },
});

describe("schema fingerprint gate", () => {
  it("applies the full DDL on first init, then skips a matching second init", async () => {
    const real = createSqliteDatabase(":memory:");

    const first = recordingDb(real);
    await initSchema(first.db, CONFIG);
    expect(first.prepares.length).toBeGreaterThan(10); // full apply

    const fp = await getMeta(real, "schema_fingerprint");
    expect(fp).toBeTruthy();

    const second = recordingDb(real);
    await initSchema(second.db, CONFIG);
    // Steady state: a single read, zero DDL.
    expect(second.prepares).toHaveLength(1);
    expect(second.prepares[0]).toMatch(/_contrail_meta/);
    expect(await getMeta(real, "schema_fingerprint")).toBe(fp); // unchanged
  });

  it("re-applies when the generated schema changes (fingerprint busts)", async () => {
    const real = createSqliteDatabase(":memory:");
    await initSchema(real, CONFIG);
    const fp1 = await getMeta(real, "schema_fingerprint");

    // Add a collection → different generated DDL → different fingerprint.
    const CONFIG2 = resolveConfig({
      namespace: "com.example",
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          queryable: { name: {} },
        },
        note: { collection: "com.example.note" },
      },
    });

    const second = recordingDb(real);
    await initSchema(second.db, CONFIG2);
    expect(second.prepares.length).toBeGreaterThan(1); // DDL ran again
    expect(await getMeta(real, "schema_fingerprint")).not.toBe(fp1);

    // The new collection's table now exists.
    const row = await real
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='records_note'"
      )
      .first();
    expect(row).toBeTruthy();
  });

  it("does not skip on a fresh database (no fingerprint row yet)", async () => {
    const real = createSqliteDatabase(":memory:");
    const rec = recordingDb(real);
    // First-ever init: the gate read hits a missing _contrail_meta, resolves
    // null, and the full apply runs.
    await initSchema(rec.db, CONFIG);
    expect(rec.prepares.length).toBeGreaterThan(10);
    expect(await getMeta(real, "schema_fingerprint")).toBeTruthy();
  });
});
