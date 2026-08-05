import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPostgresDatabase } from "../src/adapters/postgres";
import { initSchema } from "../src/index";
import { resolveConfig } from "../src/index";

/**
 * Postgres-dialect concurrent-init race.
 *
 * SQLite serializes DDL globally, so the existing `schema-idempotency.test.ts`
 * (which uses `createSqliteDatabase`) can't surface the Postgres-specific race
 * where two concurrent `CREATE TABLE IF NOT EXISTS` statements both pass the
 * existence check and then both try to insert into pg_class/pg_type, with the
 * loser raising 23505 on `pg_type_typname_nsp_index` (the unique index on
 * (typname, typnamespace)).
 *
 * Real-world hit: discovered during PR44 Phase C local validation when the OM
 * API consumer's `contrail-init-idempotency.spec.ts` ran three parallel
 * `contrail.init(db)` calls against a fresh Postgres schema.
 */

const TEST_CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { mode: {}, name: {}, startsAt: { type: "range" } },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "rsvp",
          groupBy: "status",
          groups: {
            going: "community.lexicon.calendar.rsvp#going",
          },
        },
      },
    },
    rsvp: {
      collection: "community.lexicon.calendar.rsvp",
      references: {
        event: {
          collection: "event",
          field: "subject.uri",
        },
      },
    },
  },
});

const PG_URL = process.env.TEST_DATABASE_URL;
if (!PG_URL) {
  describe.skip("PostgreSQL concurrent init (TEST_DATABASE_URL not set)", () => {
    it("skipped", () => {});
  });
} else {
  let pool: pg.Pool;
  let db: ReturnType<typeof createPostgresDatabase>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query("SELECT 1");
    db = createPostgresDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       AND (tablename LIKE 'records_%' OR tablename LIKE 'fts_%'
            OR tablename IN ('_contrail_meta', 'backfills', 'backfill_state', 'discovery', 'cursor', 'identities', 'record_versions', 'ingest_diagnostics', 'feed_items', 'feed_prune_cursor', 'feed_backfills'))`
    );
    for (const { tablename } of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS ${tablename} CASCADE`);
    }
  });

  describe("PostgreSQL initSchema under concurrency", () => {
    it("is safe to call three times concurrently against a fresh schema", async () => {
      await expect(
        Promise.all([
          initSchema(db, TEST_CONFIG),
          initSchema(db, TEST_CONFIG),
          initSchema(db, TEST_CONFIG),
        ])
      ).resolves.not.toThrow();
    });
  });
}
