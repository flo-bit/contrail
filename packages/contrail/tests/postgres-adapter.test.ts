import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresDatabase } from "../src/adapters/postgres";

function setup() {
  const client = {
    query: vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [], rowCount: 2 })),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (_sql: string, _values?: any[]) => ({
      rows: [{ record: { name: "Test" }, head_position: "42" }], rowCount: 3,
    })),
    connect: vi.fn(async () => client),
  };
  return { pool, client, db: createPostgresDatabase(pool as unknown as pg.Pool) };
}

describe("PostgreSQL adapter driver", () => {
  it("uses the pool for standalone queries and shares row normalization", async () => {
    const { pool, db } = setup();
    const stmt = db.prepare("SELECT '?' AS literal, ? AS record").bind("value");
    expect(await stmt.first()).toEqual({ record: '{"name":"Test"}', head_position: 42 });
    expect(pool.query).toHaveBeenCalledWith("SELECT '?' AS literal, $1 AS record", ["value"]);
    expect(await db.prepare("UPDATE items SET value = ?").bind("updated").run())
      .toEqual({ changes: 3 });
  });

  it("runs an entire batch on one checked-out client and releases it after commit", async () => {
    const { pool, client, db } = setup();
    expect(await db.batch([
      db.prepare("INSERT INTO items VALUES (?)").bind(1),
      db.prepare("DELETE FROM items WHERE id = ?").bind(2),
    ])).toEqual([{ changes: 2 }, { changes: 2 }]);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query.mock.calls).toEqual([
      ["BEGIN"], ["INSERT INTO items VALUES ($1)", [1]],
      ["DELETE FROM items WHERE id = $1", [2]], ["COMMIT"],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the client on batch failure", async () => {
    const { client, db } = setup();
    const error = new Error("write failed");
    client.query.mockImplementation(async (sql) => {
      if (sql.startsWith("INSERT")) throw error;
      return { rows: [], rowCount: 0 };
    });
    await expect(db.batch([db.prepare("INSERT INTO items VALUES (?)").bind(1)]))
      .rejects.toBe(error);
    expect(client.query.mock.calls).toEqual([
      ["BEGIN"], ["INSERT INTO items VALUES ($1)", [1]], ["ROLLBACK"],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("still releases the client if rollback itself fails", async () => {
    const { client, db } = setup();
    client.query.mockRejectedValue(new Error("connection lost"));
    await expect(db.batch([])).rejects.toThrow("connection lost");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
