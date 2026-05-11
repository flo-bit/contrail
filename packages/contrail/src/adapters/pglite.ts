import type { PGlite } from "@electric-sql/pglite";
import type { Database, Statement } from "../core/types";
import { postgresDialect } from "../core/dialect";

/** Internal interface for statements that can run on a specific transaction */
interface PgLiteStatement extends Statement {
  /** Execute on a specific transaction (used by batch for transaction isolation) */
  _runOn(tx: any): Promise<any>;
}

/** Column names known to be BIGINT — PostgreSQL returns these as strings */
const BIGINT_COLUMNS = new Set(["time_us", "indexed_at", "resolved_at"]);

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

export function createPgliteDatabase(pglite: PGlite): Database {
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

  function wrapStatement(sql: string, boundValues: any[] = []): PgLiteStatement {
    const pgSql = rewritePlaceholders(sql);

    return {
      bind(...values: any[]): PgLiteStatement {
        return wrapStatement(sql, values);
      },
      async run() {
        const result = await pglite.query(pgSql, boundValues);
        return { changes: result.rows.length };
      },
      async _runOn(tx: any) {
        const result = await tx.query(pgSql, boundValues);
        return { changes: result.rows.length };
      },
      async all<T>() {
        const result = await pglite.query(pgSql, boundValues);
        return { results: result.rows.map(normalizeRow) as T[] };
      },
      async first<T>() {
        const result = await pglite.query(pgSql, boundValues);
        return result.rows[0] ? (normalizeRow(result.rows[0]) as T) : null;
      },
    };
  }

  return {
    prepare(sql: string): Statement {
      return wrapStatement(sql);
    },
    async batch(stmts: Statement[]): Promise<any[]> {
      const results: any[] = [];
      await pglite.transaction(async (tx) => {
        for (const stmt of stmts) {
          results.push(await (stmt as PgLiteStatement)._runOn(tx));
        }
      });
      return results;
    },
    dialect: postgresDialect,
  };
}
