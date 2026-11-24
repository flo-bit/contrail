import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG, TEST_POSTGRES } from "./helpers";
import {
  applyLabels,
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  queryRecords,
  resolveConfig,
} from "../src/index";
import {
  applyModerationPolicy,
  moderationPolicyFingerprint,
  runModerationPolicyJob,
} from "../src/core/moderation-policy";
import { getMeta } from "../src/core/db/meta";
import type { ContrailConfig, Database } from "../src/index";

const moderator = "did:plc:moderator";
const external = "did:plc:external";
const actors = ["did:plc:a1", "did:plc:a2", "did:plc:a3", "did:plc:a4", "did:plc:a5"];
// CI's Node 22 SQLite lacks FTS5; policy coverage must still run there.
let hasFts = TEST_POSTGRES;
if (!TEST_POSTGRES) {
  try {
    await createTestDb().prepare("CREATE VIRTUAL TABLE __moderation_policy_fts USING fts5(content)").run();
    hasFts = true;
  } catch {}
}

const base: ContrailConfig = {
  ...TEST_CONFIG,
  collections: {
    ...TEST_CONFIG.collections,
    event: { ...TEST_CONFIG.collections.event, searchable: hasFts ? ["name"] : false },
  },
};
const trusted = resolveConfig({ ...base, moderation: { moderators: [moderator], reports: false } });
const untrusted = resolveConfig({
  ...base,
  moderation: { moderators: [], reports: false },
  labels: { sources: [{ did: external, subjects: "known" }] },
});
let db: Database;
let time = 100;

function hide(subject: string, rkey: string) {
  return makeEvent({
    uri: `at://${moderator}/${MODERATION_ACTION_NSID}/${rkey}`,
    did: moderator,
    collection: MODERATION_ACTION_NSID,
    rkey,
    record: { subject, action: "!hide", createdAt: "2026-01-01T00:00:00Z" },
    cid: `cid${time}`,
    time_us: ++time,
  });
}

async function visible(config: ContrailConfig) {
  return (await queryRecords(db, config, { collection: "event" })).records.length;
}

beforeEach(async () => {
  db = createTestDb();
  time = 100;
  await initSchema(db, trusted);
  await ingestRecords(
    db,
    actors.map((did) =>
      makeEvent({
        uri: `at://${did}/community.lexicon.calendar.event/e`,
        did,
        record: { name: "party" },
        time_us: ++time,
      }),
    ),
    trusted,
  );
  for (const did of actors)
    await db.prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)").bind(did).run();
  await ingestRecords(db, actors.map((did, i) => hide(did, `h${i}`)), trusted);
  expect(await visible(trusted)).toBe(0);
});

describe("moderation policy changes", () => {
  it("never rerun DDL or rebuild FTS", async () => {
    const statements: string[] = [];
    const recording: Database = {
      ...db,
      prepare: (sql) => {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: (stmts) => db.batch(stmts),
      dialect: db.dialect,
    };
    await initSchema(recording, untrusted);
    expect(statements.filter((s) => /\bCREATE\b|fts_/i.test(s))).toEqual([]);
    expect(await visible(untrusted)).toBe(actors.length);
    expect(await getMeta(db, "moderation_policy_applied")).toBe(
      moderationPolicyFingerprint(untrusted),
    );
  });

  it("prunes against allowlists larger than the bound-parameter limit", async () => {
    const source = (values?: string[]) => resolveConfig({
      ...base,
      moderation: { moderators: [], reports: false },
      labels: { sources: [{ did: external, ...(values ? { values } : {}) }] },
    });
    const open = source();
    await applyModerationPolicy(db, open);
    await applyLabels(
      db,
      ["keep", "drop"].map((val) => ({ src: external, uri: actors[0]!, val, cts: new Date().toISOString() })),
      { source: open.labels!.sources[0], config: open },
    );
    const values = ["keep", ...Array.from({ length: 149 }, (_, i) => `value-${i}`)];
    await applyModerationPolicy(db, source(values));
    expect((await db.prepare("SELECT val FROM labels WHERE src = ?").bind(external).all()).results)
      .toEqual([{ val: "keep" }]);
  });

  it("can leave the paged job to moderation cycles on request paths", async () => {
    await initSchema(db, untrusted, { deferModerationPolicyJob: true });
    // Trust changed immediately; materialized hiding catches up in the job.
    expect(
      (await db.prepare("SELECT * FROM moderation_sources WHERE moderator = 1").all()).results,
    ).toEqual([]);
    expect(await visible(untrusted)).toBe(0);
    expect(await getMeta(db, "moderation_policy_job")).not.toBeNull();
    expect(await runModerationPolicyJob(db, untrusted)).toBeGreaterThan(0);
    expect(await visible(untrusted)).toBe(actors.length);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
  });

  it("apply in bounded, resumable pages", async () => {
    await applyModerationPolicy(db, untrusted, { maxPages: 1, pageSize: 2 });
    // Trust is rewritten immediately; materialized state catches up in pages.
    expect(
      await db.prepare("SELECT 1 FROM moderation_sources WHERE did = ?").bind(moderator).first(),
    ).toBeNull();
    expect(await visible(untrusted)).toBeLessThan(actors.length);
    let runs = 0;
    while (await runModerationPolicyJob(db, untrusted, { maxPages: 1, pageSize: 2 })) runs++;
    expect(runs).toBeGreaterThan(3);
    expect(await visible(untrusted)).toBe(actors.length);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM label_backfill_queue WHERE src = ? AND completed = 0")
        .bind(external)
        .first<{ n: number }>())!.n,
    ).toBe(actors.length);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
    expect(await getMeta(db, "moderation_policy_applied")).toBe(
      moderationPolicyFingerprint(untrusted),
    );
  });

  function externalPolicy(enforce: boolean, values?: string[]) {
    return resolveConfig({
      ...base,
      labels: { sources: [{ did: external, subjects: "known", enforce, values }] },
    });
  }

  async function enforceExternalLabels() {
    const config = externalPolicy(true);
    await initSchema(db, config);
    // Isolate label enforcement: unrelated moderator actions would cause an
    // extra subject scan and accidentally mask missing label recomputation.
    await db.prepare("DELETE FROM moderation_actions").run();
    await applyLabels(
      db,
      actors.map((uri) => ({ src: external, uri, val: "!hide", cts: "2026-01-01T00:00:00Z" })),
      { config },
    );
    expect(await visible(config)).toBe(0);
    return config;
  }

  it.each(["disable", "remove"])(
    "restores external hiding after partially applying a source %s and reverting",
    async (change) => {
      const enabled = await enforceExternalLabels();
      const changed = change === "disable" ? externalPolicy(false) : resolveConfig(base);
      await applyModerationPolicy(db, changed, { maxPages: 1, pageSize: 2 });
      expect(await visible(enabled)).toBe(2);

      await applyModerationPolicy(db, enabled);
      expect(await visible(enabled)).toBe(0);
      expect(await getMeta(db, "moderation_policy_job")).toBeNull();
      expect(await getMeta(db, "moderation_policy_applied")).toBe(
        moderationPolicyFingerprint(enabled),
      );
    },
  );

  it("requeues known-source backfill after reverting partially pruned values", async () => {
    const enabled = await enforceExternalLabels();
    await db.prepare("UPDATE label_backfill_queue SET completed = 1").run();
    await applyModerationPolicy(db, externalPolicy(true, ["custom"]), { maxPages: 1, pageSize: 2 });
    expect((await db.prepare("SELECT * FROM labels").all()).results).toHaveLength(3);

    await applyModerationPolicy(db, enabled);
    expect(
      (await db.prepare("SELECT * FROM label_backfill_queue WHERE completed = 0").all()).results,
    ).toHaveLength(actors.length);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
  });

  it.each([
    ["pruning labels", "DELETE FROM labels"],
    ["recomputing hiding", "INSERT INTO moderation_dirty"],
    ["resetting backfill", "UPDATE label_backfill_queue"],
    ["enqueueing backfill", "INSERT INTO label_backfill_queue"],
    ["recording backfill policy", "INSERT INTO label_backfill_sources"],
    ["completing the job", "INSERT INTO _contrail_meta (key, value) SELECT"],
  ])("a superseded worker cannot mutate state while %s", async (_name, mutation) => {
    const enabled = await enforceExternalLabels();
    await applyLabels(db, [
      { src: external, uri: actors[0]!, val: "custom", cts: "2026-01-01T00:00:00Z" },
    ], { config: enabled });
    await db.prepare("UPDATE label_backfill_queue SET completed = 1, retries = 3").run();
    await db.prepare("DELETE FROM label_backfill_queue WHERE did = ?").bind(actors.at(-1)).run();
    const restricted = externalPolicy(true, ["!hide"]);
    await applyModerationPolicy(db, restricted, { maxPages: 0 });

    const snapshot = async () => ({
      labels: (await db.prepare("SELECT * FROM labels ORDER BY src, uri, val, cts").all()).results,
      hidden: (await db.prepare("SELECT * FROM moderation_hidden ORDER BY subject, kind, cid").all()).results,
      queue: (await db.prepare("SELECT * FROM label_backfill_queue ORDER BY src, did").all()).results,
      sources: (await db.prepare("SELECT * FROM label_backfill_sources ORDER BY src").all()).results,
      recounts: (await db.prepare("SELECT * FROM moderation_recount_queue ORDER BY subject, due_at").all()).results,
      trust: (await db.prepare("SELECT * FROM moderation_sources ORDER BY did").all()).results,
      job: await getMeta(db, "moderation_policy_job"),
      applied: await getMeta(db, "moderation_policy_applied"),
    });
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    let prepared = false;
    const racing: Database = {
      dialect: db.dialect,
      prepare(sql) {
        if (sql.startsWith(mutation)) prepared = true;
        return db.prepare(sql);
      },
      async batch(statements) {
        if (prepared && !before) {
          // Another deployment replaces this job after the page was prepared,
          // but before its transaction begins. Removed sources must not have
          // their labels, hiding or backfill state changed by the old runner.
          await applyModerationPolicy(db, resolveConfig(base), { maxPages: 0 });
          before = await snapshot();
        }
        return db.batch(statements);
      },
    };
    await runModerationPolicyJob(racing, restricted);
    expect(before).toBeDefined();
    expect(await snapshot()).toEqual(before);
    expect((await db.prepare("SELECT * FROM moderation_dirty").all()).results).toEqual([]);
  });

  it("a stale page cannot reset backfill completed by another runner of the same job", async () => {
    await enforceExternalLabels();
    const restricted = externalPolicy(true, ["!hide"]);
    await applyModerationPolicy(db, restricted, { maxPages: 0 });
    let prepared = false;
    let completed = false;
    const racing: Database = {
      dialect: db.dialect,
      prepare(sql) {
        if (sql.startsWith("UPDATE label_backfill_queue")) prepared = true;
        return db.prepare(sql);
      },
      async batch(statements) {
        if (prepared && !completed) {
          completed = true;
          await runModerationPolicyJob(db, restricted);
          // Simulate a backfill consumer finishing the freshly requeued work.
          await db.prepare("UPDATE label_backfill_queue SET completed = 1, retries = 3").run();
        }
        return db.batch(statements);
      },
    };
    await runModerationPolicyJob(racing, restricted);
    expect(completed).toBe(true);
    expect(
      (await db.prepare("SELECT * FROM label_backfill_queue WHERE completed = 1 AND retries = 3").all()).results,
    ).toHaveLength(actors.length);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
    expect(await getMeta(db, "moderation_policy_applied")).toBe(
      moderationPolicyFingerprint(restricted),
    );
  });

  it("a reverted policy replaces an unfinished job", async () => {
    await applyModerationPolicy(db, untrusted, { maxPages: 0 });
    await applyModerationPolicy(db, trusted);
    // The superseded job is never advanced under the old config.
    expect(await runModerationPolicyJob(db, untrusted)).toBe(0);
    expect(
      await db.prepare("SELECT 1 FROM moderation_sources WHERE did = ?").bind(moderator).first(),
    ).not.toBeNull();
    expect(await visible(trusted)).toBe(0);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
  });
});
