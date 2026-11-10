import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { createApp } from "../src/core/router";
import {
  applyLabels,
  getMeta,
  hydrateLabels,
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  queryRecords,
  resolveConfig,
  setMeta,
  type Database,
  type Statement,
} from "../src/index";
import { createTestDb, makeEvent, TEST_CONFIG, TEST_POSTGRES } from "./helpers";

const moderator = "did:plc:moderator";
const labeler = "did:plc:labeler";
const visible = makeEvent();
const hidden = makeEvent({
  uri: "at://did:plc:test/community.lexicon.calendar.event/hidden",
  rkey: "hidden",
});
// Node 22's bundled SQLite lacks FTS5; keep recovery coverage on that runtime.
let hasSearch = TEST_POSTGRES;
if (!TEST_POSTGRES) {
  try {
    const probe = createSqliteDatabase(":memory:");
    await probe.prepare("CREATE VIRTUAL TABLE __view_repair_fts USING fts5(content)").run();
    hasSearch = true;
  } catch {}
}
const config = resolveConfig({
  ...TEST_CONFIG,
  collections: {
    ...TEST_CONFIG.collections,
    event: { ...TEST_CONFIG.collections.event!, searchable: hasSearch ? ["name"] : false },
  },
  moderation: { moderators: [moderator], reports: false },
  labels: { sources: [{ did: labeler }] },
  logger: { log() {}, warn() {}, error() {} },
});

function recordingDb(real: Database) {
  const prepares: string[] = [];
  const batches: string[][] = [];
  const sqlByStatement = new WeakMap<Statement, string>();
  const db: Database = {
    dialect: real.dialect,
    prepare(sql) {
      prepares.push(sql);
      const statement = real.prepare(sql);
      sqlByStatement.set(statement, sql);
      return statement;
    },
    batch(statements) {
      batches.push(statements.map((s) => sqlByStatement.get(s) ?? "<bound>"));
      return real.batch(statements);
    },
  };
  return { db, prepares, batches };
}

async function setup(db = createTestDb()) {
  await initSchema(db, config);
  await ingestRecords(db, [visible, hidden, makeEvent({
    collection: "community.lexicon.calendar.rsvp",
    uri: "at://did:plc:attendee/community.lexicon.calendar.rsvp/going",
    did: "did:plc:attendee",
    rkey: "going",
    record: { subject: { uri: visible.uri }, status: "community.lexicon.calendar.rsvp#going" },
  }), makeEvent({
    collection: MODERATION_ACTION_NSID,
    uri: `at://${moderator}/${MODERATION_ACTION_NSID}/hide`,
    did: moderator,
    rkey: "hide",
    record: { subject: hidden.uri, action: "!hide", createdAt: "2026-01-01T00:00:00Z" },
  })], config);
  await applyLabels(db, [{
    src: labeler, uri: visible.uri, val: "test-label", cts: "2026-01-01T00:00:00Z",
  }], { config });
  await db.prepare("INSERT INTO cursor (id, time_us) VALUES (1, 123456)").run();
  return db;
}

async function snapshot(db: Database) {
  const tables = [
    "records_event", "records_rsvp", "record_versions", "_contrail_projection_state",
    "cursor", "source_position", "labels", "moderation_actions", "moderation_overrides",
    "moderation_hidden", "moderation_sources",
    ...(!TEST_POSTGRES && hasSearch ? ["fts_event", "fts_event_rows"] : []),
  ];
  return Promise.all(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
}

describe("schema view recovery", () => {
  it.each(["current", "before cursor observations"])(
    "repairs a missing moderation view with a %s fingerprint without rebuilding projections",
    async (version) => {
      const real = await setup();
      const current = (await getMeta(real, "schema_fingerprint"))!;
      const before = await snapshot(real);
      const labelsBefore = await hydrateLabels(real, [visible.uri, hidden.uri], [labeler, moderator]);
      await real.prepare("DROP VIEW moderation_effective_labels").run();
      if (version !== "current") {
        await real.prepare("DROP TABLE cursor_observations").run();
        await setMeta(real, "schema_fingerprint", current.replace(/:cursor-observations-v1$/, ""));
      }

      const repaired = recordingDb(real);
      await initSchema(repaired.db, config);

      expect(await hydrateLabels(real, [visible.uri, hidden.uri], [labeler, moderator])).toEqual(labelsBefore);
      expect(await snapshot(real)).toEqual(before);
      expect(await getMeta(real, "schema_fingerprint")).toBe(current);
      expect(repaired.prepares.some((sql) => /^CREATE (OR REPLACE )?VIEW/.test(sql))).toBe(true);
      expect(repaired.prepares.some((sql) => /DROP VIEW|fts_event|records_event|record_versions/.test(sql))).toBe(false);
      if (version === "current") expect(repaired.prepares).toHaveLength(2); // One read, one targeted DDL.

      // Exercise the same label-hydration path that failed in production.
      const response = await createApp(real, config).request("/xrpc/com.example.event.listRecords");
      expect(response.status).toBe(200);
      expect((await response.json()).records.map((r: { uri: string }) => r.uri)).toEqual([visible.uri]);
      if (hasSearch) {
        expect((await queryRecords(real, config, { collection: "event", search: "Test" })).records)
          .toHaveLength(1);
      }

      const steady = recordingDb(real);
      await initSchema(steady.db, config);
      expect(steady.prepares).toHaveLength(1); // Healthy databases still run no DDL.
    },
  );

  it("propagates a failed repair and retries it on the next initialization", async () => {
    const real = await setup();
    const fingerprint = await getMeta(real, "schema_fingerprint");
    const before = await snapshot(real);
    await real.prepare("DROP VIEW moderation_effective_labels").run();
    const broken: Database = {
      dialect: real.dialect,
      prepare(sql) {
        if (/^CREATE (OR REPLACE )?VIEW/.test(sql)) throw new Error("View repair failed");
        return real.prepare(sql);
      },
      batch: (statements) => real.batch(statements),
    };
    await expect(initSchema(broken, config)).rejects.toThrow("View repair failed");
    expect(await getMeta(real, "schema_fingerprint")).toBe(fingerprint);
    expect(await snapshot(real)).toEqual(before);
    await initSchema(real, config);
    expect((await hydrateLabels(real, [visible.uri], [labeler]))[visible.uri]).toHaveLength(1);
  });

  it("is safe when multiple initializers repair the same missing view", async () => {
    const db = await setup();
    await db.prepare("DROP VIEW moderation_effective_labels").run();
    await Promise.all([initSchema(db, config), initSchema(db, config), initSchema(db, config)]);
    expect((await hydrateLabels(db, [visible.uri], [labeler]))[visible.uri]).toHaveLength(1);
  });
});

describe.skipIf(TEST_POSTGRES)("SQLite moderation view replacement", () => {
  it("replaces the view in one atomic batch on a full schema upgrade", async () => {
    const real = await setup(createSqliteDatabase(":memory:"));
    await setMeta(real, "schema_fingerprint", "force-full-upgrade");
    const upgraded = recordingDb(real);
    await initSchema(upgraded.db, config);
    expect(upgraded.batches.some((statements) =>
      statements.some((sql) => sql.startsWith("DROP VIEW")) &&
      statements.some((sql) => sql.startsWith("CREATE VIEW")),
    )).toBe(true);
  });

  it("keeps the existing view when its replacement batch fails", async () => {
    const real = await setup(createSqliteDatabase(":memory:"));
    const labelsBefore = await hydrateLabels(real, [visible.uri, hidden.uri], [labeler, moderator]);
    await setMeta(real, "schema_fingerprint", "force-full-upgrade");
    const sqlByStatement = new WeakMap<Statement, string>();
    const broken: Database = {
      dialect: real.dialect,
      prepare(sql) {
        const statement = real.prepare(sql);
        sqlByStatement.set(statement, sql);
        return statement;
      },
      batch(statements) {
        if (statements.some((s) => sqlByStatement.get(s)?.startsWith("DROP VIEW"))) {
          return real.batch([...statements, real.prepare("INSERT INTO __fail_view_replacement VALUES (1)")]);
        }
        return real.batch(statements);
      },
    };
    await expect(initSchema(broken, config)).rejects.toThrow(/__fail_view_replacement/);
    expect(await getMeta(real, "schema_fingerprint")).toBe("force-full-upgrade");
    expect(await hydrateLabels(real, [visible.uri, hidden.uri], [labeler, moderator])).toEqual(labelsBefore);
  });
});
