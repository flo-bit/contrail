import type { Database, Statement } from "../core/types";
import { postgresDialect } from "../core/dialect";

/** Driver-independent query shape shared by pg and PGlite. */
export type PostgresQuery = (
  sql: string,
  values: any[],
) => Promise<{ rows: any[]; rowCount: number | null }>;

interface PostgresDriver {
  query: PostgresQuery;
  transaction<T>(run: (query: PostgresQuery) => Promise<T>): Promise<T>;
}

interface PostgresStatement extends Statement {
  _runOn(query: PostgresQuery): Promise<{ changes: number | null }>;
}

/** Column names known to be BIGINT — PostgreSQL returns these as strings. */
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

function normalizeRow(row: any): any {
  if (!row) return row;
  if (typeof row.record === "object" && row.record !== null) {
    row.record = JSON.stringify(row.record);
  }
  for (const col of BIGINT_COLUMNS) {
    if (typeof row[col] === "string") row[col] = Number(row[col]);
  }
  return row;
}

function rewritePlaceholders(sql: string): string {
  let idx = 0;
  let inString = false;
  let result = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== "\\") {
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
  function wrapStatement(sql: string, boundValues: any[] = []): PostgresStatement {
    const pgSql = rewritePlaceholders(sql);
    const runOn = async (query: PostgresQuery) => {
      const result = await query(pgSql, boundValues);
      return { changes: result.rowCount };
    };

    return {
      bind(...values: any[]): PostgresStatement {
        return wrapStatement(sql, values);
      },
      run() {
        return runOn(driver.query);
      },
      _runOn: runOn,
      async all<T>() {
        const result = await driver.query(pgSql, boundValues);
        return { results: result.rows.map(normalizeRow) as T[] };
      },
      async first<T>() {
        const result = await driver.query(pgSql, boundValues);
        return result.rows[0] ? (normalizeRow(result.rows[0]) as T) : null;
      },
    };
  }

  return {
    prepare(sql: string): Statement {
      return wrapStatement(sql);
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
