import { describe, it, expect } from "vitest";
import { sqliteDialect, postgresDialect, buildFtsSchema, ftsQueryClause } from "../src/core/dialect";
import { createSqliteDatabase } from "../src/adapters/sqlite";

describe("sqliteDialect", () => {
  it("generates json_extract for flat field", () => {
    expect(sqliteDialect.jsonExtract("record", "name")).toBe(
      "json_extract(record, '$.name')"
    );
  });

  it("generates json_extract for nested field", () => {
    expect(sqliteDialect.jsonExtract("record", "subject.uri")).toBe(
      "json_extract(record, '$.subject.uri')"
    );
  });

  it("generates json_extract for aliased column", () => {
    expect(sqliteDialect.jsonExtract("r.record", "mode")).toBe(
      "json_extract(r.record, '$.mode')"
    );
  });

  it("wraps statement with OR IGNORE", () => {
    const sql = "INSERT INTO feed_items (actor, uri) SELECT ?, ? FROM t WHERE x = ?";
    expect(sqliteDialect.insertOrIgnore(sql)).toBe(
      "INSERT OR IGNORE INTO feed_items (actor, uri) SELECT ?, ? FROM t WHERE x = ?"
    );
  });

  it("reports recordColumnType as TEXT", () => {
    expect(sqliteDialect.recordColumnType).toBe("TEXT");
  });

  it("reports ftsStrategy as virtual-table", () => {
    expect(sqliteDialect.ftsStrategy).toBe("virtual-table");
  });

});

describe("Database.dialect", () => {
  it("sqlite adapter exposes sqliteDialect", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.dialect).toBeDefined();
    expect(db.dialect.recordColumnType).toBe("TEXT");
  });
});

describe("postgresDialect", () => {
  it("generates ->> for flat field", () => {
    expect(postgresDialect.jsonExtract("record", "name")).toBe(
      "record->>'name'"
    );
  });

  it("generates -> then ->> for nested field", () => {
    expect(postgresDialect.jsonExtract("record", "subject.uri")).toBe(
      "record->'subject'->>'uri'"
    );
  });

  it("handles aliased column", () => {
    expect(postgresDialect.jsonExtract("r.record", "mode")).toBe(
      "r.record->>'mode'"
    );
  });

  it("handles deeply nested field", () => {
    expect(postgresDialect.jsonExtract("record", "a.b.c")).toBe(
      "record->'a'->'b'->>'c'"
    );
  });

  it("appends ON CONFLICT DO NOTHING", () => {
    const sql = "INSERT INTO feed_items (actor, uri) SELECT ?, ? FROM t WHERE x = ?";
    expect(postgresDialect.insertOrIgnore(sql)).toBe(
      "INSERT INTO feed_items (actor, uri) SELECT ?, ? FROM t WHERE x = ? ON CONFLICT DO NOTHING"
    );
  });

  it("reports recordColumnType as JSONB", () => {
    expect(postgresDialect.recordColumnType).toBe("JSONB");
  });

  it("reports ftsStrategy as generated-column", () => {
    expect(postgresDialect.ftsStrategy).toBe("generated-column");
  });

});

describe("indexExpression", () => {
  it("sqlite passes through expression unchanged", () => {
    expect(sqliteDialect.indexExpression("json_extract(record, '$.name')")).toBe(
      "json_extract(record, '$.name')"
    );
  });

  it("postgres wraps expression in parens", () => {
    expect(postgresDialect.indexExpression("record->>'name'")).toBe(
      "(record->>'name')"
    );
  });
});

describe("FTS schema generation", () => {
  it("sqlite generates virtual table", () => {
    const stmts = buildFtsSchema(sqliteDialect, "records_community_lexicon_calendar_event", ["name", "description"]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("CREATE VIRTUAL TABLE");
    expect(stmts[0]).toContain("USING fts5");
  });

  it("postgres generates tsvector column + GIN index", () => {
    const stmts = buildFtsSchema(postgresDialect, "records_community_lexicon_calendar_event", ["name", "description"]);
    expect(stmts.length).toBeGreaterThanOrEqual(2);
    expect(stmts.some(s => s.includes("tsvector"))).toBe(true);
    expect(stmts.some(s => s.includes("USING GIN"))).toBe(true);
  });
});

describe("FTS query clause", () => {
  it("sqlite uses FTS5 join and MATCH", () => {
    const clause = ftsQueryClause(sqliteDialect, "records_community_lexicon_calendar_event");
    expect(clause.join).toContain("JOIN fts_");
    expect(clause.condition).toContain("MATCH");
    expect(clause.orderExpr).toBe("fts.rank");
  });

  it("postgres uses tsvector condition and ts_rank", () => {
    const clause = ftsQueryClause(postgresDialect, "records_community_lexicon_calendar_event");
    expect(clause.join).toBe("");
    expect(clause.condition).toContain("plainto_tsquery");
    expect(clause.orderExpr).toContain("ts_rank");
  });
});
