import type { Database } from "../types";
import { getDialect, postgresDialect } from "../dialect";

/**
 * Refresh the query planner's statistics so multi-predicate queries pick the
 * selective index rather than the planner's default heuristic.
 *
 * SQLite/D1 only. Runs a CPU-bounded `PRAGMA optimize`: `analysis_limit` caps
 * the rows sampled per run so it can't exceed D1's per-query CPU budget and
 * reset the shared Durable Object — the same guardrail the feed prune needs (a
 * raw unbounded `ANALYZE` on a large table is exactly that failure mode).
 * `PRAGMA optimize` only reanalyzes tables whose stats are stale, so it's a
 * near-no-op once warmed; the first call on a never-analyzed DB does the bulk
 * of the work, which `analysis_limit` bounds.
 *
 * No-op on Postgres, where autovacuum/autoanalyze maintains planner stats.
 *
 * Surfaces errors to the caller (e.g. an environment that rejects the pragmas);
 * the auto-run in the ingest tick wraps this so maintenance can't break ingest.
 */
export async function optimizeDatabase(
  db: Database,
  analysisLimit = 400
): Promise<void> {
  if (getDialect(db) === postgresDialect) return;

  try {
    await db
      .prepare(`PRAGMA analysis_limit = ${Math.max(0, Math.floor(analysisLimit))}`)
      .run();
  } catch {
    // Some environments reject analysis_limit; PRAGMA optimize is still safe to
    // run (just potentially less bounded), so don't abort on this.
  }
  await db.prepare("PRAGMA optimize").run();
}
