/**
 * Wrangler-backed helpers for Cloudflare Workers deployments:
 *
 *   - `backfillAll` — one-time bulk record load from scratch (uses the
 *     `backfills` state table to resume across runs).
 *   - `labelsBackfillAll` — drain pending events per configured labeler in
 *     repeated cycles until each labeler's cursor stops advancing.
 *
 * All dynamically import `wrangler` (optional peer dep) and wire it to
 * the user's D1 binding, then dispose the proxy on exit.
 */
import { Contrail } from "../contrail.js";
import type { ContrailConfig, Database } from "../core/types.js";
import type { BackfillAllOptions } from "../core/backfill.js";
import type { BackfillStatus } from "../core/status.js";

interface WranglerCommon {
  config: ContrailConfig;
  /** Use production D1 bindings. Equivalent to
   *  `getPlatformProxy({ environment: "production" })`. */
  remote?: boolean;
  /** Name of the D1 binding in wrangler.jsonc. Default: `"DB"`. */
  binding?: string;
}

export interface BackfillAllViaWranglerOptions extends WranglerCommon {
  /** Passed through to `contrail.backfillAll()`. Default: 100. */
  concurrency?: number;
  /** Failed attempts allowed in this run before a row remains pending. */
  maxAttempts?: number;
  /** Override the built-in progress logging. */
  onProgress?: BackfillAllOptions["onProgress"];
}

async function withWrangler<T>(
  opts: WranglerCommon,
  fn: (contrail: Contrail, db: Database) => Promise<T>
): Promise<T> {
  // Dynamic import so wrangler is only required when these helpers are
  // actually called — keeps the main package usable in runtimes without it.
  const { getPlatformProxy } = await import("wrangler");
  const binding = opts.binding ?? "DB";

  const { env, dispose } = await getPlatformProxy({
    environment: opts.remote ? "production" : undefined,
  });

  const db = (env as Record<string, unknown>)[binding] as Database | undefined;
  if (!db) {
    await dispose();
    throw new Error(
      `No binding named "${binding}" in wrangler env. Add a d1_databases ` +
        `entry to wrangler.jsonc, or pass { binding: "..." }.`
    );
  }

  try {
    const contrail = new Contrail(opts.config);
    await contrail.init(db);
    return await fn(contrail, db);
  } finally {
    await dispose();
  }
}

export async function backfillAll(
  opts: BackfillAllViaWranglerOptions
): Promise<{
  discovered: number;
  backfilled: number;
  status: BackfillStatus;
}> {
  return withWrangler(opts, (contrail, db) =>
    contrail.backfillAll(
      {
        concurrency: opts.concurrency ?? 100,
        maxAttempts: opts.maxAttempts,
        onProgress: opts.onProgress,
      },
      db
    )
  );
}

export interface LabelsBackfillAllViaWranglerOptions extends WranglerCommon {
  /** Per-cycle subscribe timeout passed to `contrail.ingestLabels()`. Default: 60s. */
  cycleTimeoutMs?: number;
  /** Called after each cycle with whether any cursor advanced. */
  onCycle?: (info: { cycle: number; advanced: boolean }) => void;
}

export interface LabelsBackfillAllResult {
  /** Total ingest cycles run before any labeler stopped advancing twice in a row. */
  cycles: number;
  /** Whether labels were configured at all — false means we no-op'd. */
  ran: boolean;
}

/**
 * Drain pending events from each configured labeler. Runs `ingestLabels`
 * in a loop, checking the `labeler_cursors` table after each cycle, and
 * stops once two consecutive cycles fail to advance any cursor.
 */
export async function labelsBackfillAll(
  opts: LabelsBackfillAllViaWranglerOptions
): Promise<LabelsBackfillAllResult> {
  return withWrangler(opts, async (contrail, db) => {
    if (!opts.config.labels || opts.config.labels.sources.length === 0) {
      return { cycles: 0, ran: false };
    }
    const timeoutMs = opts.cycleTimeoutMs ?? 60_000;
    let cycles = 0;
    let stable = 0;
    while (stable < 2) {
      const before = new Map<string, number>();
      const beforeRows =
        (
          await db
            .prepare("SELECT did, cursor FROM labeler_cursors")
            .all<{ did: string; cursor: number }>()
        ).results ?? [];
      for (const r of beforeRows) before.set(r.did, r.cursor);

      await contrail.ingestLabels({ timeoutMs }, db);
      cycles++;

      const afterRows =
        (
          await db
            .prepare("SELECT did, cursor FROM labeler_cursors")
            .all<{ did: string; cursor: number }>()
        ).results ?? [];
      let advanced = false;
      for (const r of afterRows) {
        if ((before.get(r.did) ?? -1) !== r.cursor) {
          advanced = true;
          break;
        }
      }
      stable = advanced ? 0 : stable + 1;
      opts.onCycle?.({ cycle: cycles, advanced });
    }
    return { cycles, ran: true };
  });
}
