import BetterSqlite3 from "better-sqlite3";
import type { Database, Statement } from "../core/types";
import { sqliteDialect } from "../core/dialect";

export function createSqliteDatabase(path: string): Database {
  const raw = new BetterSqlite3(path);
  raw.pragma("journal_mode = WAL");

  function wrapStatement(sql: string, boundValues: any[] = []): Statement {
    return {
      bind(...values: any[]): Statement {
        return wrapStatement(sql, values);
      },
      async run() {
        return raw.prepare(sql).run(...boundValues);
      },
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
      const results: any[] = [];
      for (const stmt of stmts) {
        results.push(await stmt.run());
      }
      return results;
    },
    dialect: sqliteDialect,
  };
}
