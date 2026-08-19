import { FTS_TRIM_CODE_POINTS } from "./search";

/** Get the dialect from a Database, defaulting to SQLite (for D1 compatibility) */
export function getDialect(db: { dialect?: SqlDialect }): SqlDialect {
  return db.dialect ?? sqliteDialect;
}

const SAFE_FIELD = /^[a-zA-Z0-9_.]+$/;

function assertSafeField(field: string): void {
  if (!SAFE_FIELD.test(field)) {
    throw new Error(`Invalid field name: ${field}`);
  }
}

/** Build the SQLite expression used by both incremental and set-based FTS
 * projection. Only JSON string values participate, matching buildFtsContent(). */
export function sqliteFtsContentExpression(
  fields: string[],
  recordColumn = "record",
): string {
  assertSafeField(recordColumn);
  if (fields.length === 0) throw new Error("FTS fields must not be empty");
  const terms = fields.map((field) => {
    assertSafeField(field);
    const path = `$.${field}`;
    return `CASE WHEN json_type(${recordColumn}, '${path}') = 'text' THEN json_extract(${recordColumn}, '${path}') ELSE '' END`;
  });
  const trimCharacters = `char(${FTS_TRIM_CODE_POINTS.join(", ")})`;
  return `trim(${terms.join(" || ' ' || ")}, ${trimCharacters})`;
}

export interface SqlDialect {
  /** json_extract(col, '$.field') or col->>'field' */
  jsonExtract(column: string, field: string): string;

  /** Convert INSERT INTO to ignore-duplicates form.
   *  SQLite: INSERT INTO → INSERT OR IGNORE INTO
   *  PG: appends ON CONFLICT DO NOTHING
   *  Accepts full SQL starting with "INSERT INTO" (works with both VALUES and SELECT). */
  insertOrIgnore(sql: string): string;

  /** Column type for the record column: TEXT (SQLite) or JSONB (PostgreSQL) */
  readonly recordColumnType: string;

  /** FTS strategy: 'virtual-table' (SQLite FTS5) or 'generated-column' (PG tsvector) */
  readonly ftsStrategy: "virtual-table" | "generated-column";

  /** INTEGER type name — same on both, but PostgreSQL may want BIGINT for time_us */
  readonly integerType: string;

  /** BIGINT type name for timestamps */
  readonly bigintType: string;

  /** Wrap an expression for use in CREATE INDEX — PostgreSQL requires parens around expressions */
  indexExpression(expr: string): string;
}

export const sqliteDialect: SqlDialect = {
  jsonExtract(column: string, field: string): string {
    assertSafeField(field);
    return `json_extract(${column}, '$.${field}')`;
  },

  insertOrIgnore(sql: string): string {
    return sql.replace(/^INSERT INTO/, "INSERT OR IGNORE INTO");
  },

  recordColumnType: "TEXT",
  ftsStrategy: "virtual-table",
  integerType: "INTEGER",
  bigintType: "INTEGER",

  indexExpression(expr: string): string {
    return expr;
  },
};

export const postgresDialect: SqlDialect = {
  jsonExtract(column: string, field: string): string {
    assertSafeField(field);
    const parts = field.split(".");
    if (parts.length === 1) {
      return `${column}->>'${parts[0]}'`;
    }
    // a.b.c → col->'a'->'b'->>'c'
    const intermediate = parts.slice(0, -1).map((p) => `->'${p}'`).join("");
    return `${column}${intermediate}->>'${parts[parts.length - 1]}'`;
  },

  insertOrIgnore(sql: string): string {
    return `${sql} ON CONFLICT DO NOTHING`;
  },

  recordColumnType: "JSONB",
  ftsStrategy: "generated-column",
  integerType: "INTEGER",
  bigintType: "BIGINT",

  indexExpression(expr: string): string {
    return `(${expr})`;
  },
};

/** Generate FTS schema statements based on dialect */
export function buildFtsSchema(
  dialect: SqlDialect,
  recordsTable: string,
  fields: string[]
): string[] {
  if (dialect.ftsStrategy === "virtual-table") {
    const ftsTable = recordsTable.replace("records_", "fts_");
    const rowsTable = `${ftsTable}_rows`;
    return [
      `CREATE TABLE IF NOT EXISTS ${rowsTable} (
        id INTEGER PRIMARY KEY,
        uri TEXT NOT NULL UNIQUE
      )`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(content)`,
    ];
  } else {
    const concatExpr = fields
      .map((f) => `COALESCE(${dialect.jsonExtract("record", f)}, '')`)
      .join(" || ' ' || ");
    return [
      `ALTER TABLE ${recordsTable} ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', ${concatExpr})) STORED`,
      `CREATE INDEX IF NOT EXISTS idx_${recordsTable}_search ON ${recordsTable} USING GIN (search_vector)`,
    ];
  }
}

/** Generate FTS query clause based on dialect */
export function ftsQueryClause(
  dialect: SqlDialect,
  recordsTable: string
): {
  join: string;
  condition: string;
  orderExpr: string;
  orderDirection: "asc" | "desc";
} {
  if (dialect.ftsStrategy === "virtual-table") {
    const ftsTable = recordsTable.replace("records_", "fts_");
    const rowsTable = `${ftsTable}_rows`;
    return {
      join: `JOIN ${rowsTable} fts_rows ON fts_rows.uri = r.uri JOIN ${ftsTable} fts ON fts.rowid = fts_rows.id`,
      condition: "fts.content MATCH ?",
      orderExpr: "fts.rank",
      orderDirection: "asc",
    };
  } else {
    return {
      join: "",
      condition: "r.search_vector @@ plainto_tsquery('english', ?)",
      orderExpr: "ts_rank(r.search_vector, plainto_tsquery('english', ?))",
      orderDirection: "desc",
    };
  }
}
