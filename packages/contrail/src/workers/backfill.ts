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
import {
  getDiscoverableNsids,
  recordsTableName,
  type ContrailConfig,
  type Database,
} from "../core/types.js";
import type { BackfillAllOptions } from "../core/backfill.js";
import type { BackfillStatus } from "../core/status.js";
import { DatabaseBootstrapTarget } from "../core/bootstrap.js";
import { bootstrapFreshProjection, type SourcePosition } from "../core/sources.js";
import { getLastCursor } from "../core/db/records.js";
import {
  createAlluviumBootstrapSources,
  createAlluviumLiveCursor,
  type AlluviumTransportOptions,
} from "../adapters/alluvium.js";

interface WranglerCommon {
  config: ContrailConfig;
  /** Exact generated/pinned bundle for collections with `validate: true`. */
  lexicons?: object[];
  /** Use production D1 bindings. Equivalent to
   *  `getPlatformProxy({ environment: "production" })`. */
  remote?: boolean;
  /** Name of the D1 binding in wrangler.jsonc. Default: `"DB"`. */
  binding?: string;
}

export interface BackfillAllViaWranglerOptions extends WranglerCommon {
  /** Concurrent identity resolutions. Default: 100. */
  concurrency?: number;
  /** PDS hosts fetched concurrently. Default: 20. */
  pdsConcurrency?: number;
  /** Accounts fetched concurrently from each PDS. Default: 3. */
  didsPerPds?: number;
  /** Immediate attempts before scheduled retries take over. Default: 1. */
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
    const contrail = new Contrail({
      ...opts.config,
      lexicons: opts.lexicons,
    });
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
        pdsConcurrency: opts.pdsConcurrency,
        didsPerPds: opts.didsPerPds,
        maxAttempts: opts.maxAttempts,
        onProgress: opts.onProgress,
      },
      db
    )
  );
}

export interface AlluviumBootstrapOptions {
  /** Alluvium HTTP origin. Default: {@link DEFAULT_ALLUVIUM_ENDPOINT}. */
  endpoint?: string | URL;
  /** Bearer token, when the service requires one. */
  token?: string;
  /** Ordered source the projection is served from after bootstrap. Default:
   * `config.orderedSource`, or `jetstream` / `alluvium-export` without one. */
  sourceId?: string;
  sourceEpoch?: string;
  /** How far before the export's head live ingestion resumes. */
  rewindUs?: number;
  transport?: AlluviumTransportOptions;
  /** Build the record tables' secondary indexes once after the load
   * instead of maintaining them per row. Use for a local SQLite file; leave
   * off for D1, where one statement cannot index a large table in time. */
  deferIndexes?: boolean;
}

export interface AlluviumBootstrapViaWranglerOptions
  extends WranglerCommon, AlluviumBootstrapOptions {}

export interface AlluviumBootstrapDatabaseOptions extends AlluviumBootstrapOptions {
  config: ContrailConfig;
  db: Database;
  /** Exact generated/pinned bundle for collections with `validate: true`. */
  lexicons?: object[];
}

export interface AlluviumBootstrapResult {
  elapsedMs: number;
  /** Position live ingestion resumes from: a timestamp cursor. */
  handoff: SourcePosition;
  liveCursor: number;
  resumed: boolean;
}

async function assertFreshBootstrapDatabase(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  const cursor = await getLastCursor(db);
  const versionRow = await db
    .prepare("SELECT COUNT(*) AS count FROM record_versions")
    .first<{ count: number | string }>();
  let visibleRecords = 0;
  for (const shortName of Object.keys(config.collections)) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${recordsTableName(shortName)}`)
      .first<{ count: number | string }>();
    visibleRecords += Number(row?.count ?? 0);
  }
  const versions = Number(versionRow?.count ?? 0);
  if (cursor !== null || versions > 0 || visibleRecords > 0) {
    throw new Error(
      "Alluvium bootstrap requires a fresh unpublished database. " +
        "Create or select a new database instead of resetting an active generation.",
    );
  }
}

async function runAlluviumBootstrap(
  contrail: Contrail,
  db: Database,
  opts: AlluviumBootstrapOptions,
): Promise<AlluviumBootstrapResult> {
  const ordered = contrail.config.orderedSource;
  const source = {
    id: opts.sourceId ?? ordered?.source ?? "jetstream",
    epoch: opts.sourceEpoch ?? ordered?.epoch ?? "alluvium-export",
  };
  if (ordered && (ordered.source !== source.id || ordered.epoch !== source.epoch)) {
    throw new Error(
      "Alluvium source ID/epoch must match the configured orderedSource",
    );
  }
  const target = new DatabaseBootstrapTarget(db, contrail.config, {
    deferDerivedProjections: true,
    deferSecondaryIndexes: opts.deferIndexes === true,
    liveCursor: createAlluviumLiveCursor(source),
  });
  const prior = await target.load();
  if (!prior) await assertFreshBootstrapDatabase(db, contrail.config);

  const sources = createAlluviumBootstrapSources(contrail.config, {
    endpoint: opts.endpoint,
    token: opts.token,
    source,
    rewindUs: opts.rewindUs,
    transport: opts.transport,
  });
  const started = performance.now();
  const result = await bootstrapFreshProjection({
    // Profiles, follows, and other dependent collections remain separately
    // accounted PDS enrichment rather than being misrepresented as Alluvium
    // coverage.
    collections: getDiscoverableNsids(contrail.config),
    ...sources,
    target,
  });
  const liveCursor = await getLastCursor(db);
  if (liveCursor === null || liveCursor !== Number(result.through.cursor)) {
    throw new Error("Alluvium bootstrap did not persist its live cursor");
  }
  return {
    elapsedMs: Math.round(performance.now() - started),
    handoff: result.through,
    liveCursor,
    resumed: prior !== null,
  };
}

/** Load a fresh database from an Alluvium export and seed the ordinary
 * scheduled-ingestion cursor just before the export's head. */
export async function bootstrapAlluviumDatabase(
  opts: AlluviumBootstrapDatabaseOptions,
): Promise<AlluviumBootstrapResult> {
  const contrail = new Contrail({
    ...opts.config,
    lexicons: opts.lexicons,
  });
  await contrail.init(opts.db);
  return runAlluviumBootstrap(contrail, opts.db, opts);
}

/** Wrangler/D1 counterpart to {@link bootstrapAlluviumDatabase}. */
export async function bootstrapAlluvium(
  opts: AlluviumBootstrapViaWranglerOptions,
): Promise<AlluviumBootstrapResult> {
  return withWrangler(opts, (contrail, db) =>
    runAlluviumBootstrap(contrail, db, opts),
  );
}

export interface LabelsBackfillOptions {
  /** Per-cycle subscribe timeout passed to `contrail.ingestLabels()`. Default: 60s. */
  cycleTimeoutMs?: number;
  /** Called after each cycle with whether any cursor advanced. */
  onCycle?: (info: { cycle: number; advanced: boolean }) => void;
}

export interface LabelsBackfillAllViaWranglerOptions
  extends WranglerCommon, LabelsBackfillOptions {}

export interface LabelsBackfillDatabaseOptions extends LabelsBackfillOptions {
  config: ContrailConfig;
  db: Database;
  /** Exact generated/pinned bundle for collections with `validate: true`. */
  lexicons?: object[];
}

export interface LabelsBackfillAllResult {
  /** Total ingest cycles run before any labeler stopped advancing twice in a row. */
  cycles: number;
  /** Whether labels were configured at all — false means we no-op'd. */
  ran: boolean;
}

/** Drain pending events from each configured labeler until two consecutive
 * cycles stop advancing any cursor. */
async function runLabelsBackfill(
  contrail: Contrail,
  db: Database,
  opts: LabelsBackfillOptions,
): Promise<LabelsBackfillAllResult> {
  if (!contrail.config.labels || contrail.config.labels.sources.length === 0) {
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
}

export async function labelsBackfillDatabase(
  opts: LabelsBackfillDatabaseOptions,
): Promise<LabelsBackfillAllResult> {
  const contrail = new Contrail({
    ...opts.config,
    lexicons: opts.lexicons,
  });
  await contrail.init(opts.db);
  return runLabelsBackfill(contrail, opts.db, opts);
}

export async function labelsBackfillAll(
  opts: LabelsBackfillAllViaWranglerOptions,
): Promise<LabelsBackfillAllResult> {
  return withWrangler(opts, (contrail, db) =>
    runLabelsBackfill(contrail, db, opts),
  );
}
