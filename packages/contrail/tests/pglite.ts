import { PGlite } from "@electric-sql/pglite";
import { onTestFinished } from "vitest";
import { createPgliteDatabase as createDatabase } from "../src/adapters/pglite";
import type { Database } from "../src/index";

const idle: PGlite[] = [];
const leased = new Set<PGlite>();
const suiteScoped = new Set<PGlite>();

async function resetPgliteInstance(pg: PGlite): Promise<void> {
  if (!leased.delete(pg)) return;
  try {
    await pg.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    idle.push(pg);
  } catch (error) {
    console.warn(
      "[test:pglite] failed to reset pooled instance; discarding:",
      error,
    );
    await pg.close().catch(() => {});
  }
}

/** In-process PostgreSQL for dialect coverage without a server.
 *
 * Calls inside a test or `beforeEach` lease a pooled PGlite instance per
 * Vitest worker whose `public` schema is reset when the test finishes (via
 * `onTestFinished` and the `tests/setup.ts` safety net), avoiding hundreds of
 * WASM initdb boots. Calls outside an active test (e.g. `beforeAll` or module
 * scope) get a dedicated suite-scoped instance that is preserved across tests
 * and closed in `afterAll`. */
export function createPgliteDatabase(): Database {
  let pg: PGlite | undefined;
  let pooled = false;
  try {
    onTestFinished(async () => {
      if (pg) await resetPgliteInstance(pg);
    });
    pooled = true;
  } catch {
    // Outside an active test (`beforeAll` / module scope): keep dedicated.
  }
  pg = pooled ? (idle.pop() ?? new PGlite()) : new PGlite();
  if (pooled) {
    leased.add(pg);
  } else {
    suiteScoped.add(pg);
  }
  return createDatabase(pg);
}

export async function resetLeasedPgliteDatabases(): Promise<void> {
  for (const pg of [...leased]) {
    await resetPgliteInstance(pg);
  }
}

export async function closeAllPgliteDatabases(): Promise<void> {
  const all = [...idle.splice(0), ...leased, ...suiteScoped];
  leased.clear();
  suiteScoped.clear();
  for (const pg of all) {
    await pg.close().catch(() => {});
  }
}
