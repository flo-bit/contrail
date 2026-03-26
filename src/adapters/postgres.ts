import pg from "pg";
import type { Database, Statement } from "../core/types";
import { postgresDialect } from "../core/dialect";

/** Internal interface for statements that can run on a specific client */
interface PgStatement extends Statement {
  /** Execute on a specific client (used by batch for transaction isolation) */
  _runOn(client: pg.PoolClient): Promise<any>;
}

function normalizeRow(row: any): any {
  if (row && typeof row.record === "object" && row.record !== null) {
    row.record = JSON.stringify(row.record);
  }
  // PostgreSQL returns BIGINT as string — coerce numeric fields back to number
  if (row && typeof row.time_us === "string") row.time_us = Number(row.time_us);
  if (row && typeof row.indexed_at === "string") row.indexed_at = Number(row.indexed_at);
  if (row && typeof row.resolved_at === "string") row.resolved_at = Number(row.resolved_at);
  return row;
}

export function createPostgresDatabase(pool: pg.Pool): Database {
  function rewritePlaceholders(sql: string): string {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
  }

  function wrapStatement(sql: string, boundValues: any[] = []): PgStatement {
    const pgSql = rewritePlaceholders(sql);

    return {
      bind(...values: any[]): PgStatement {
        return wrapStatement(sql, values);
      },
      async run() {
        const result = await pool.query(pgSql, boundValues);
        return { changes: result.rowCount };
      },
      async _runOn(client: pg.PoolClient) {
        const result = await client.query(pgSql, boundValues);
        return { changes: result.rowCount };
      },
      async all<T>() {
        const result = await pool.query(pgSql, boundValues);
        return { results: result.rows.map(normalizeRow) as T[] };
      },
      async first<T>() {
        const result = await pool.query(pgSql, boundValues);
        return result.rows[0] ? (normalizeRow(result.rows[0]) as T) : null;
      },
    };
  }

  return {
    prepare(sql: string): Statement {
      return wrapStatement(sql);
    },
    async batch(stmts: Statement[]): Promise<any[]> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results: any[] = [];
        for (const stmt of stmts) {
          results.push(await (stmt as PgStatement)._runOn(client));
        }
        await client.query("COMMIT");
        return results;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    dialect: postgresDialect,
  };
}
