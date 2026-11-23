import type { Database, Statement } from "../core/types";
import { postgresDialect } from "../core/dialect";

/** Column metadata returned by pg and PGlite drivers. */
export interface PostgresField {
  name: string;
  dataTypeID: number;
}

/** Driver-independent query shape shared by pg and PGlite. */
export type PostgresQuery = (
  sql: string,
  values: any[],
) => Promise<{
  rows: any[];
  rowCount: number | null;
  fields?: PostgresField[];
}>;

interface PostgresDriver {
  query: PostgresQuery;
  transaction<T>(run: (query: PostgresQuery) => Promise<T>): Promise<T>;
}

interface PostgresStatement extends Statement {
  _runOn(query: PostgresQuery): Promise<{ changes: number | null }>;
}

/** PostgreSQL built-in OID for INT8 / BIGINT (returned as strings by pg/PGlite). */
const PG_INT8_OID = 20;

/** Fallback BIGINT column names used only when a driver omits `fields` metadata
 *  (e.g. lightweight test doubles). Real pg/PGlite queries coerce by PG OID 20. */
const BIGINT_COLUMNS = new Set([
  "time_us",
  "source_time_us",
  "indexed_at",
  "last_seen_at",
  "resolved_at",
  "total",
  "revision",
  "head_position",
  "retained_floor_position",
  "position",
  "acknowledged_position",
  "bootstrap_anchor_position",
  "bootstrap_target_position",
  "from_position",
  "through_position",
  "lease_expires_at",
  "next_attempt_at",
  "last_success_at",
  "last_error_at",
  "created_at",
  "updated_at",
  "cts",
  "exp",
]);

function normalizeRow(row: any, int8Columns?: Iterable<string>): any {
  if (!row) return row;
  if (typeof row.record === "object" && row.record !== null) {
    row.record = JSON.stringify(row.record);
  }
  for (const col of BIGINT_COLUMNS) {
    if (typeof row[col] === "string") row[col] = Number(row[col]);
  }
  if (int8Columns) {
    for (const col of int8Columns) {
      if (typeof row[col] === "string") row[col] = Number(row[col]);
    }
  }
  return row;
}

function int8ColumnsFromFields(fields?: PostgresField[]): string[] | undefined {
  if (!fields) return undefined;
  const cols: string[] = [];
  for (const field of fields) {
    if (field.dataTypeID === PG_INT8_OID && !BIGINT_COLUMNS.has(field.name)) {
      cols.push(field.name);
    }
  }
  return cols.length > 0 ? cols : undefined;
}

function rewritePlaceholders(sql: string): string {
  let idx = 0;
  let inString = false;
  let result = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      inString = !inString;
      result += ch;
    } else if (ch === "?" && !inString) {
      result += `$${++idx}`;
    } else {
      result += ch;
    }
  }
  return result;
}

export function createPostgresAdapter(driver: PostgresDriver): Database {
  function wrapStatement(pgSql: string, boundValues: any[] = []): PostgresStatement {
    const runOn = async (query: PostgresQuery) => {
      const result = await query(pgSql, boundValues);
      return { changes: result.rowCount };
    };

    return {
      bind(...values: any[]): PostgresStatement {
        return wrapStatement(pgSql, values);
      },
      run() {
        return runOn(driver.query);
      },
      _runOn: runOn,
      async all<T>() {
        const result = await driver.query(pgSql, boundValues);
        const int8Cols = int8ColumnsFromFields(result.fields);
        return {
          results: result.rows.map((row) => normalizeRow(row, int8Cols)) as T[],
        };
      },
      async first<T>() {
        const result = await driver.query(pgSql, boundValues);
        const int8Cols = int8ColumnsFromFields(result.fields);
        return result.rows[0]
          ? (normalizeRow(result.rows[0], int8Cols) as T)
          : null;
      },
    };
  }

  return {
    prepare(sql: string): Statement {
      return wrapStatement(rewritePlaceholders(sql));
    },
    batch(stmts: Statement[]): Promise<any[]> {
      return driver.transaction(async (query) => {
        const results: any[] = [];
        for (const stmt of stmts) {
          results.push(await (stmt as PostgresStatement)._runOn(query));
        }
        return results;
      });
    },
    dialect: postgresDialect,
  };
}
