import { describe, expect, it } from "vitest";
import {
  postgresDialect,
  queryRecords,
  resolveConfig,
  sqliteDialect,
  type Database,
  type Statement,
} from "../src/index";

const config = resolveConfig({
  namespace: "com.example",
  profiles: [],
  collections: {
    event: {
      collection: "com.example.event",
      searchable: ["name"],
    },
  },
});

function createQueryRecorder(
  pages: Record<string, unknown>[][],
  dialect = sqliteDialect,
) {
  const calls: { sql: string; bindings: unknown[] }[] = [];
  const db: Database = {
    dialect,
    prepare(sql: string): Statement {
      let bindings: unknown[] = [];
      const statement: Statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async run() {
          throw new Error("unexpected run");
        },
        async all<T>() {
          calls.push({ sql, bindings });
          return { results: (pages.shift() ?? []) as T[] };
        },
        async first() {
          throw new Error("unexpected first");
        },
      };
      return statement;
    },
    async batch() {
      throw new Error("unexpected batch");
    },
  };
  return { db, calls };
}

describe("query keyset pagination", () => {
  it("carries search rank, time, and URI into the next-page predicate", async () => {
    const row = {
      uri: "at://did:plc:a/com.example.event/a",
      did: "did:plc:a",
      rkey: "a",
      cid: "cid-a",
      record: JSON.stringify({ name: "Rust" }),
      time_us: 1000,
      indexed_at: 1000,
      __search_rank: -2.5,
    };
    const { db, calls } = createQueryRecorder([[row], []]);

    const first = await queryRecords(db, config, {
      collection: "event",
      search: "Rust",
      limit: 1,
    });
    await queryRecords(db, config, {
      collection: "event",
      search: "Rust",
      limit: 1,
      cursor: first.cursor,
    });

    expect(calls[1].sql).toContain(
      "fts.rank > ? OR (fts.rank = ? AND (r.time_us < ? OR (r.time_us = ? AND r.uri > ?)))",
    );
    expect(calls[1].sql).toContain(
      "ORDER BY fts.rank ASC, r.time_us DESC, r.uri ASC",
    );
    expect(calls[1].bindings).toEqual([
      "Rust",
      -2.5,
      -2.5,
      1000,
      1000,
      row.uri,
      1,
    ]);
  });

  it("binds PostgreSQL rank expressions in SQL placeholder order", async () => {
    const row = {
      uri: "at://did:plc:a/com.example.event/a",
      did: "did:plc:a",
      rkey: "a",
      cid: "cid-a",
      record: JSON.stringify({ name: "Rust" }),
      time_us: 1000,
      indexed_at: 1000,
      __search_rank: 2.5,
    };
    const { db, calls } = createQueryRecorder([[row], []], postgresDialect);

    const first = await queryRecords(db, config, {
      collection: "event",
      search: "Rust",
      limit: 1,
    });
    await queryRecords(db, config, {
      collection: "event",
      search: "Rust",
      limit: 1,
      cursor: first.cursor,
    });

    expect(calls[1].sql).toContain(
      "ORDER BY ts_rank(r.search_vector, plainto_tsquery('english', ?)) DESC, r.time_us DESC, r.uri ASC",
    );
    expect(calls[1].bindings).toEqual([
      "Rust",
      "Rust",
      "Rust",
      2.5,
      "Rust",
      2.5,
      1000,
      1000,
      row.uri,
      "Rust",
      1,
    ]);
  });
});
