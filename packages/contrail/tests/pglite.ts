import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase as createDatabase } from "../src/adapters/pglite";
import type { Database } from "../src/index";

const idle: PGlite[] = [];
const leased: PGlite[] = [];

/** In-process PostgreSQL for dialect coverage without a server. Reuses pooled
 * PGlite instances per Vitest worker and resets `public` between tests via
 * `tests/setup.ts`, avoiding hundreds of WASM initdb boots. */
export function createPgliteDatabase(): Database {
  const pg = idle.pop() ?? new PGlite();
  leased.push(pg);
  return createDatabase(pg);
}

export async function resetLeasedPgliteDatabases(): Promise<void> {
  const active = leased.splice(0);
  for (const pg of active) {
    try {
      await pg.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      idle.push(pg);
    } catch {
      await pg.close().catch(() => {});
    }
  }
}

export async function closeAllPgliteDatabases(): Promise<void> {
  const all = [...idle.splice(0), ...leased.splice(0)];
  for (const pg of all) {
    await pg.close().catch(() => {});
  }
}
