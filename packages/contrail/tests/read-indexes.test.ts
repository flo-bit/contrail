import { describe, expect, it } from "vitest";
import {
  buildDynamicIndexes, getMeta, hydrateLabels, ingestRecords, initSchema, queryRecords, resolveConfig,
  setMeta, sqliteDialect, postgresDialect,
} from "../src/index";
import type { Database, Statement } from "../src/index";
import { createTestDb, makeEvent, TEST_POSTGRES } from "./helpers";

// PostgreSQL supports search, but CI's Node 22 SQLite lacks FTS5. Keep the
// index/migration tests running there with search disabled, rather than
// skipping unrelated coverage or seeding into nonexistent FTS tables.
let hasSearch = TEST_POSTGRES;
if (!TEST_POSTGRES) {
  try {
    const probe = createTestDb();
    await probe.prepare("CREATE VIRTUAL TABLE __read_indexes_fts USING fts5(content)").run();
    await probe.prepare("DROP TABLE __read_indexes_fts").run();
    hasSearch = true;
  } catch {}
}

const CONFIG = resolveConfig({
  namespace: "com.example",
  profiles: [],
  collections: {
    post: {
      collection: "com.example.post",
      queryable: { category: {}, "nested.kind": {}, rank: { type: "range" } },
      searchable: hasSearch ? ["text"] : false,
      relations: { replies: { collection: "reply", field: "subject.uri" } },
    },
    reply: {
      collection: "com.example.reply",
      queryable: { "subject.uri": {} },
      references: { post: { collection: "post", field: "subject.uri" } },
    },
    follow: {
      collection: "com.example.follow", discover: false, subjectField: "subject", queryable: { subject: {} },
    },
  },
  feeds: { following: { follow: "follow", targets: ["post"], maxItems: 20 } },
});

// Captured from the unmodified v17 initializer at ec26161, not computed by
// the code under test. The SQLite fixtures cover both searchable settings.
const LEGACY_FINGERPRINT = TEST_POSTGRES ? "68e79e3b243f7797"
  : hasSearch ? "97324484d78152a8" : "e82ed02846a73e3c";
const EQUALITY_FIELDS = [
  ["post", "category"], ["post", "nested.kind"], ["reply", "subject.uri"], ["follow", "subject"],
] as const;

function recordingDb(real: Database) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db: Database = {
    dialect: real.dialect,
    prepare(sql) {
      function wrap(statement: Statement, args: unknown[] = []): Statement {
        return {
          bind: (...values) => wrap(statement.bind(...values), values),
          async all<T>() { calls.push({ sql, args }); return statement.all<T>(); },
          async first<T>() { calls.push({ sql, args }); return statement.first<T>(); },
          async run() { calls.push({ sql, args }); return statement.run(); },
        };
      }
      return wrap(real.prepare(sql));
    },
    batch: (statements) => real.batch(statements),
  };
  return { db, calls };
}

async function indexDefinitions(db: Database) {
  const rows = await db.prepare(TEST_POSTGRES
    ? "SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE schemaname = 'public'"
    : "SELECT name, sql FROM sqlite_master WHERE type = 'index'").all<{ name: string; sql: string }>();
  return new Map(rows.results.map((row) => [row.name, row.sql]));
}

async function expectReadIndexes(db: Database) {
  const indexes = await indexDefinitions(db);
  expect(indexes.has("idx_feed_uri")).toBe(true);
  for (const [collection, field] of EQUALITY_FIELDS) {
    const name = `idx_${collection}_${field.replaceAll(".", "_")}`;
    expect(indexes.has(`${name}_time_uri`)).toBe(true);
    expect(indexes.has(name)).toBe(false);
    expect(indexes.get(`${name}_time_uri`)).toContain("time_us DESC");
    expect(indexes.get(`${name}_time_uri`)).toMatch(/uri(?: ASC)?\)/);
  }
  expect(indexes.has("idx_post_rank")).toBe(true);
  expect(indexes.get("idx_post_rank")).not.toContain("time_us");
  expect(indexes.has("idx_post_rank_time_uri")).toBe(false);
}

async function seed(db: Database) {
  const events = Array.from({ length: 48 }, (_, i) => makeEvent({
    did: "did:plc:author", collection: "com.example.post", rkey: `p${String(i).padStart(3, "0")}`,
    uri: `at://did:plc:author/com.example.post/p${String(i).padStart(3, "0")}`,
    cid: `cid-${i}`, time_us: 1_000_000, indexed_at: 1_000_000,
    record: { category: i % 3 ? "photos" : "other", nested: { kind: "example" }, rank: String(i), text: `Searchable sample ${i}` },
  }));
  await ingestRecords(db, events, CONFIG);
  return events;
}

async function downgradeIndexes(db: Database) {
  const dialect = TEST_POSTGRES ? postgresDialect : sqliteDialect;
  await db.prepare("DROP INDEX idx_feed_uri").run();
  for (const [collection, field] of EQUALITY_FIELDS) {
    const name = `idx_${collection}_${field.replaceAll(".", "_")}`;
    await db.prepare(`DROP INDEX ${name}_time_uri`).run();
    await db.prepare(`CREATE INDEX ${name} ON records_${collection}(${dialect.indexExpression(dialect.jsonExtract("record", field))})`).run();
  }
}

async function snapshot(db: Database, hasObservations = true) {
  return {
    records: (await db.prepare("SELECT * FROM records_post ORDER BY uri").all()).results,
    versions: (await db.prepare("SELECT * FROM record_versions ORDER BY uri").all()).results,
    observations: hasObservations ? (await db.prepare("SELECT * FROM cursor_observations ORDER BY time_us, observation").all()).results : [],
    hidden: (await db.prepare("SELECT * FROM moderation_hidden ORDER BY subject").all()).results,
    cursor: await db.prepare("SELECT * FROM cursor").first(),
    feeds: (await db.prepare("SELECT * FROM feed_items ORDER BY actor, uri").all()).results,
    labels: (await db.prepare("SELECT * FROM labels ORDER BY src, uri, val").all()).results,
    fts: hasSearch ? (await db.prepare(TEST_POSTGRES
      ? "SELECT uri, search_vector::text FROM records_post ORDER BY uri"
      : "SELECT id, uri FROM fts_post_rows ORDER BY id").all()).results : [],
  };
}

async function expectIndexOnlyUpgrade(db: Database, hasObservations = true) {
  const before = await snapshot(db, hasObservations);
  const recorded = recordingDb(db);
  let extraSchemas = 0;
  await initSchema(recorded.db, CONFIG, { extraSchemas: [async () => { extraSchemas++; }] });
  expect(extraSchemas).toBe(1);
  await expectReadIndexes(db);
  expect(await snapshot(db)).toEqual(before);
  const sql = recorded.calls.map((call) => call.sql).join("\n");
  expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE) record_versions|(?:DELETE FROM|INSERT INTO) fts_|ALTER TABLE|UPDATE records_/i);
  expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_feed_uri");
  const current = await getMeta(db, "schema_fingerprint");
  expect(current).not.toBe(`${LEGACY_FINGERPRINT}:cursor-observations-v1`);
  const warm = recordingDb(db);
  await initSchema(warm.db, CONFIG);
  expect(warm.calls).toHaveLength(1);
}

describe("bounded record read indexes", () => {
  it("builds ordered equality indexes and retains range indexes in both dialects", () => {
    for (const dialect of [sqliteDialect, postgresDialect]) {
      const sql = buildDynamicIndexes(CONFIG, dialect);
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS idx_post_category_time_uri ON records_post(${dialect.indexExpression(dialect.jsonExtract("record", "category"))}, time_us DESC, uri ASC)`);
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS idx_post_rank ON records_post(${dialect.indexExpression(dialect.jsonExtract("record", "rank"))})`);
      expect(sql.some((statement) => /idx_reply_subject_uri ON/.test(statement))).toBe(false);
    }
  });

  it("creates only the nonredundant indexes on fresh and repeated initialization", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    await initSchema(db, CONFIG);
    await expectReadIndexes(db);
  });

  it.each([
    "current", "without-cursor-observations", "interrupted",
    "missing-view", "missing-view-without-cursor-observations",
  ])("upgrades the real previous fingerprint without rewriting data: %s", async (variant) => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    const posts = await seed(db);
    await ingestRecords(db, [makeEvent({
      uri: "at://did:plc:author/com.example.reply/r", did: "did:plc:author", collection: "com.example.reply", rkey: "r",
      record: { subject: { uri: posts[0]!.uri } }, time_us: 2_000_000,
    })], CONFIG);
    await db.prepare("INSERT INTO feed_items (actor, uri, collection, time_us) VALUES ('did:plc:reader', ?, 'com.example.post', 1)").bind(posts[0]!.uri).run();
    await db.prepare("INSERT INTO labels (src, uri, val, cts) VALUES ('did:plc:labeler', ?, 'warn', 1000)").bind(posts[0]!.uri).run();
    await db.prepare("INSERT INTO cursor (id, time_us) VALUES (1, 123)").run();
    await db.prepare("INSERT INTO cursor_observations VALUES (123, 'preserve-me')").run();
    await db.prepare("INSERT INTO moderation_hidden (subject, kind) VALUES (?, 'label')").bind(posts[1]!.uri).run();
    await downgradeIndexes(db);
    const hasObservations = !variant.endsWith("without-cursor-observations");
    await setMeta(db, "schema_fingerprint", LEGACY_FINGERPRINT + (hasObservations ? ":cursor-observations-v1" : ""));
    if (!hasObservations) await db.prepare("DROP TABLE cursor_observations").run();
    if (variant.startsWith("missing-view")) await db.prepare("DROP VIEW moderation_effective_labels").run();
    if (variant === "interrupted") {
      await db.prepare(buildDynamicIndexes(CONFIG, TEST_POSTGRES ? postgresDialect : sqliteDialect)[0]!).run();
      await db.prepare("DROP INDEX idx_post_category").run();
    }
    await expectIndexOnlyUpgrade(db, hasObservations);
    expect((await hydrateLabels(db, [posts[0]!.uri], ["did:plc:labeler"]))[posts[0]!.uri]).toHaveLength(1);
    if (hasSearch) {
      const search = await queryRecords(db, CONFIG, { collection: "post", search: "sample", limit: 5 });
      expect(search.records).toHaveLength(5);
    }
  });

  it("does not confuse a field ending in time_uri with another field's replacement index", async () => {
    const config = resolveConfig({ namespace: "com.example", collections: {
      post: { collection: "com.example.post", queryable: { category: {}, category_time_uri: {} } },
    } });
    const db = createTestDb();
    await initSchema(db, config);
    await initSchema(db, config);
    const indexes = await indexDefinitions(db);
    expect(indexes.get("idx_post_category_time_uri_list")).toContain("category");
    expect(indexes.get("idx_post_category_time_uri_time_uri")).toContain("category_time_uri");
    expect(indexes.has("idx_post_category_time_uri")).toBe(false);
  });

  it("replaces rather than accumulates index variants when a field changes type", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    const range = resolveConfig({ ...CONFIG, collections: { ...CONFIG.collections, post: {
      ...CONFIG.collections.post!, queryable: { ...CONFIG.collections.post!.queryable, category: { type: "range" } },
    } } });
    await initSchema(db, range);
    let indexes = await indexDefinitions(db);
    expect(indexes.has("idx_post_category")).toBe(true);
    expect(indexes.has("idx_post_category_time_uri")).toBe(false);
    await initSchema(db, CONFIG);
    indexes = await indexDefinitions(db);
    expect(indexes.has("idx_post_category")).toBe(false);
    expect(indexes.has("idx_post_category_time_uri")).toBe(true);
  });

  it("retries an interrupted upgrade without advancing its fingerprint on failure", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    await downgradeIndexes(db);
    const prior = `${LEGACY_FINGERPRINT}:cursor-observations-v1`;
    await setMeta(db, "schema_fingerprint", prior);
    const broken: Database = {
      ...db,
      prepare(sql) {
        if (sql.startsWith("DROP INDEX IF EXISTS idx_post_category")) throw new Error("simulated interrupted index upgrade");
        return db.prepare(sql);
      },
    };
    await expect(initSchema(broken, CONFIG)).rejects.toThrow("simulated interrupted");
    expect(await getMeta(db, "schema_fingerprint")).toBe(prior);
    await initSchema(db, CONFIG);
    await expectReadIndexes(db);
  });

  it("is safe for concurrent upgrade initializers", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    await downgradeIndexes(db);
    await setMeta(db, "schema_fingerprint", `${LEGACY_FINGERPRINT}:cursor-observations-v1`);
    await Promise.all([initSchema(db, CONFIG), initSchema(db, CONFIG), initSchema(db, CONFIG)]);
    await expectReadIndexes(db);
  });

  it("preserves filtering, moderation and timestamp ties across every page", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    const posts = await seed(db);
    const hidden = new Set(posts.filter((_, i) => i >= 1 && i <= 13).map((post) => post.uri));
    await db.batch([...hidden].map((uri) => db.prepare("INSERT INTO moderation_hidden (subject, kind) VALUES (?, 'label')").bind(uri)));
    const expected = posts.filter((post, i) => i % 3 && !hidden.has(post.uri)).map((post) => post.uri).sort();
    const actual: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await queryRecords(db, CONFIG, { collection: "post", filters: { category: "photos", "nested.kind": "example" }, limit: 5, cursor });
      actual.push(...result.records.map((record) => record.uri));
      if (!result.cursor) break;
      cursor = result.cursor;
    }
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    const range = await queryRecords(db, CONFIG, { collection: "post", rangeFilters: { rank: { min: "40", max: "47" } } });
    expect(range.records).toHaveLength(8);
  });

  it("deletes every feed copy of a record without touching unrelated items", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    const posts = await seed(db);
    for (const actor of ["did:plc:one", "did:plc:two", "did:plc:three"]) {
      await db.batch(posts.slice(0, 2).map((post) => db.prepare("INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, 'com.example.post', 1)").bind(actor, post.uri)));
    }
    await ingestRecords(db, [{ ...posts[0]!, operation: "delete", record: null, cid: null, time_us: 2_000_000 }], CONFIG);
    const rows = await db.prepare("SELECT uri FROM feed_items").all<{ uri: string }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.every((row) => row.uri === posts[1]!.uri)).toBe(true);
  });

  it.skipIf(TEST_POSTGRES)("uses the equality ordering and URI deletion indexes without a temporary sort", async () => {
    const db = createTestDb();
    await initSchema(db, CONFIG);
    await seed(db);
    const recorded = recordingDb(db);
    const first = await queryRecords(recorded.db, CONFIG, { collection: "post", filters: { category: "photos" }, limit: 5 });
    await queryRecords(recorded.db, CONFIG, { collection: "post", filters: { category: "photos" }, limit: 5, cursor: first.cursor });
    for (const { sql, args } of recorded.calls) {
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join("\n");
      expect(details).toContain("idx_post_category_time_uri");
      expect(details).not.toContain("USE TEMP B-TREE");
    }
    const plan = await db.prepare("EXPLAIN QUERY PLAN DELETE FROM feed_items WHERE uri = ?").bind("at://example").all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("SEARCH feed_items USING INDEX idx_feed_uri"))).toBe(true);
  });
});
