import { describe, expect, it } from "vitest";
import { createTestDb, TEST_CONFIG, TEST_POSTGRES } from "./helpers";
import { initSchema, resolveConfig } from "../src/index";
import { getMeta } from "../src/core/db/meta";
import {
  MODERATION_SOURCES_KEY,
  moderationSourcesFingerprint,
} from "../src/core/moderation";
import { needsModerationCycle } from "../src/core/moderation-sync";
import type { ContrailConfig, Database } from "../src/index";

const moderator = "did:plc:moderator";
const external = "did:plc:external";

let hasFts = TEST_POSTGRES;
if (!TEST_POSTGRES) {
  try {
    await createTestDb()
      .prepare("CREATE VIRTUAL TABLE __moderation_sources_fts USING fts5(content)")
      .run();
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

describe("moderation sources sync", () => {
  it("updates moderation_sources without rerunning DDL or rebuilding FTS, and does zero writes on warm init", async () => {
    const db = createTestDb();
    const initial = resolveConfig({
      ...base,
      moderation: { moderators: [moderator], reports: false },
    });
    await initSchema(db, initial);

    expect(
      (await db.prepare("SELECT did, moderator, enforced FROM moderation_sources ORDER BY did").all()).results,
    ).toEqual([{ did: moderator, moderator: 1, enforced: 1 }]);
    expect(await getMeta(db, MODERATION_SOURCES_KEY)).toBe(
      moderationSourcesFingerprint(initial),
    );

    // Seed legacy keys from earlier versions to verify cleanup on sync.
    await db
      .prepare("INSERT INTO _contrail_meta (key, value) VALUES ('moderation_policy_job', '{}'), ('moderation_policy_generation', '{}')")
      .run();

    const updated = resolveConfig({
      ...base,
      moderation: { moderators: [], reports: false },
      labels: { sources: [{ did: external, enforce: true, subjects: "known" }] },
    });
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

    await initSchema(recording, updated);
    expect(statements.filter((s) => /\bCREATE\b|fts_/i.test(s))).toEqual([]);
    expect(
      (await db.prepare("SELECT did, moderator, enforced FROM moderation_sources ORDER BY did").all()).results,
    ).toEqual([{ did: external, moderator: 0, enforced: 1 }]);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
    expect(await getMeta(db, "moderation_policy_generation")).toBeNull();

    // Warm init with unchanged config performs zero writes.
    statements.length = 0;
    await initSchema(recording, updated);
    expect(statements.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s))).toEqual([]);
  });

  it("gates background moderation cycles when no moderators, known labelers, or counted relations are configured", () => {
    const plain = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: { post: { collection: "com.example.post" } },
    });
    expect(needsModerationCycle(plain)).toBe(false);
    expect(
      needsModerationCycle(
        resolveConfig({
          ...plain,
          moderation: { moderators: [moderator], reports: false },
        }),
      ),
    ).toBe(true);
    expect(
      needsModerationCycle(
        resolveConfig({
          ...plain,
          labels: { sources: [{ did: external, subjects: "known" }] },
        }),
      ),
    ).toBe(true);
    expect(
      needsModerationCycle(
        resolveConfig({
          ...plain,
          labels: { sources: [{ did: external }] },
        }),
      ),
    ).toBe(false);
    expect(needsModerationCycle(resolveConfig(TEST_CONFIG))).toBe(true);
  });
});
