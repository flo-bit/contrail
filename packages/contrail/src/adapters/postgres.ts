import type pg from "pg";
import type { Database } from "../core/types";
import { createPostgresAdapter } from "./postgres-shared";

export function createPostgresDatabase(pool: pg.Pool): Database {
  return createPostgresAdapter({
    query: (sql, values) => pool.query(sql, values),
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await run((sql, values) => client.query(sql, values));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  });
}
