import { DatabaseSync } from "node:sqlite";
import type { Database, Statement } from "../core/types";
import { sqliteDialect } from "../core/dialect";

interface SqliteStatement extends Statement {
  _runSync(): unknown;
}

export function createSqliteDatabase(path: string): Database {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");

  function wrapStatement(
    sql: string,
    boundValues: any[] = []
  ): SqliteStatement {
    const runSync = () => raw.prepare(sql).run(...boundValues);
    return {
      bind(...values: any[]): SqliteStatement {
        return wrapStatement(sql, values);
      },
      async run() {
        return runSync();
      },
      _runSync: runSync,
      async all<T>() {
        return { results: raw.prepare(sql).all(...boundValues) as T[] };
      },
      async first<T>() {
        return (raw.prepare(sql).get(...boundValues) as T) ?? null;
      },
    };
  }

  return {
    prepare(sql: string): Statement {
      return wrapStatement(sql);
    },
    async batch(stmts: Statement[]): Promise<any[]> {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const results: unknown[] = [];
        // Keep the whole transaction synchronous. Yielding between statements
        // allows another concurrent batch to start a nested transaction on this
        // single SQLite connection.
        for (const stmt of stmts) {
          results.push((stmt as SqliteStatement)._runSync());
        }
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    dialect: sqliteDialect,
  };
}
