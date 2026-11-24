import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createPostgresDatabase } from "../src/adapters/postgres";
import {
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  queryRecords,
  resolveConfig,
} from "../src/index";
import { accountUpdateStatements } from "../src/core/moderation";
import { makeEvent, TEST_CONFIG } from "./helpers";

it("locks moderation before account rows in PostgreSQL lifecycle batches", async () => {
  const query = vi.fn(async (_sql: string) => ({ rowCount: 1 }));
  const client = { query, release: vi.fn() };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const db = createPostgresDatabase(pool);
  await db.batch(accountUpdateStatements(db, [
    { did: "did:plc:test", active: false, cursor: 1, timeUs: 1_000 },
  ], TEST_CONFIG));
  const sql = query.mock.calls.map(([statement]) => statement);
  expect(sql[0]).toBe("BEGIN");
  expect(sql[1]).toMatch(/^SELECT pg_advisory_xact_lock\(/);
  expect(sql[2]).toContain("INSERT INTO account_state");
  expect(sql.at(-1)).toBe("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("PostgreSQL moderation concurrency", () => {
  it("commits overlapping account-only and mixed action/account batches without deadlocking", async () => {
    const schema = `moderation_lock_${crypto.randomUUID().replaceAll("-", "")}`;
    const control = new pg.Client({ connectionString: PG_URL });
    const options = `-c search_path=${schema} -c statement_timeout=5000`;
    const mixedPool = new pg.Pool({ connectionString: PG_URL, max: 1, options });
    const accountPool = new pg.Pool({ connectionString: PG_URL, max: 1, options });
    const mixedDb = createPostgresDatabase(mixedPool);
    const accountDb = createPostgresDatabase(accountPool);
    const tasks: Promise<unknown>[] = [];
    const track = (task: Promise<unknown>) => {
      tasks.push(task);
      // Observe errors immediately while the test coordinates the other worker.
      void task.catch(() => {});
    };
    // A separate gate pauses the mixed batch after it holds the moderation
    // lock, but before it writes account_state. The other worker must wait for
    // moderation without first locking the same account row.
    const gate = 0x6d6f65;
    const waitForAdvisoryWait = async (pid: number) => {
      for (let i = 0; i < 200; i++) {
        const result = await control.query(
          "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted",
          [pid],
        );
        if (result.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Worker ${pid} did not reach its advisory lock`);
    };
    await control.connect();
    try {
      await control.query(`CREATE SCHEMA ${schema}`);
      const config = resolveConfig({
        namespace: "com.example",
        profiles: [],
        collections: { event: { collection: "community.lexicon.calendar.event" } },
        moderation: { moderators: ["did:plc:moderator"], reports: false },
      });
      await initSchema(mixedDb, config);
      await ingestRecords(mixedDb, [makeEvent()], config);
      await mixedDb.batch(accountUpdateStatements(mixedDb, [
        { did: "did:plc:test", active: true, cursor: 1, timeUs: 1_000 },
      ], config));
      const mixedPid = (await mixedPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const accountPid = (await accountPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await control.query("SELECT pg_advisory_lock($1)", [gate]);
      track(ingestRecords(mixedDb, [makeEvent({
        uri: `at://did:plc:moderator/${MODERATION_ACTION_NSID}/action`,
        did: "did:plc:moderator",
        collection: MODERATION_ACTION_NSID,
        rkey: "action",
        record: { subject: "did:plc:test", action: "!hide", createdAt: new Date().toISOString() },
      })], config, {
        trailingStatements: [
          mixedDb.prepare(`SELECT pg_advisory_xact_lock(${gate})`),
          ...accountUpdateStatements(mixedDb, [
            { did: "did:plc:test", active: false, cursor: 20, timeUs: 20_000 },
          ], config),
        ],
      }));
      await waitForAdvisoryWait(mixedPid);
      track(accountDb.batch(accountUpdateStatements(accountDb, [
        { did: "did:plc:test", active: true, cursor: 30, timeUs: 30_000 },
      ], config)));
      await waitForAdvisoryWait(accountPid);
      await control.query("SELECT pg_advisory_unlock($1)", [gate]);
      const results = await Promise.allSettled(tasks);
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      const account = await mixedDb.prepare("SELECT active, cursor FROM account_state")
        .first<{ active: number; cursor: string | number }>();
      expect(account?.active).toBe(1);
      expect(Number(account?.cursor)).toBe(30);
      expect((await mixedDb.prepare("SELECT * FROM moderation_actions").all()).results).toHaveLength(1);
      expect((await queryRecords(mixedDb, config, { collection: "event" })).records).toEqual([]);
    } finally {
      await control.query("SELECT pg_advisory_unlock($1)", [gate]);
      await Promise.allSettled(tasks);
      await Promise.all([mixedPool.end(), accountPool.end()]);
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await control.end();
    }
  }, 15_000);
});
