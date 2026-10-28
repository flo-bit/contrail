import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Database } from "../core/types";
import { createPostgresAdapter, type PostgresQuery } from "./postgres-shared";

function queryOn(db: PGlite | Transaction): PostgresQuery {
  return async (sql, values) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}

/** Use a caller-owned PGlite instance. Close it with `pglite.close()` when done. */
export function createPgliteDatabase(pglite: PGlite): Database {
  return createPostgresAdapter({
    query: queryOn(pglite),
    transaction: (run) => pglite.transaction((tx) => run(queryOn(tx))),
  });
}
