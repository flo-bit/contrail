import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase as createDatabase } from "../src/adapters/pglite";
import type { Database } from "../src/index";

/** In-process PostgreSQL for dialect coverage without a server. PGlite
 * serializes transactions; this doesn't check cross-connection locking. */
export function createPgliteDatabase(): Database {
  return createDatabase(new PGlite());
}
