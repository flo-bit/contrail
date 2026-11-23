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
  type ContrailConfig,
  type Database,
  type SourcePosition,
} from "../core/types.js";
import type { BackfillAllOptions } from "../core/backfill.js";
import type { BackfillStatus } from "../core/status.js";
import {
  loadAlluviumExport,
  type AlluviumProgress,
  type AlluviumTransportOptions,
} from "../adapters/alluvium.js";
import { openWranglerD1 } from "./wrangler.js";

interface WranglerCommon {
  config: ContrailConfig;
  /** Exact generated/pinned bundle for collections with `validate: true`. */
  lexicons?: object[];
  /** Connect to the remote Cloudflare D1 database for `binding` (fails closed
   * if the remote binding cannot be established). */
  remote?: boolean;
  /** Name of the D1 binding in wrangler.jsonc. Default: `"DB"`. */
  binding?: string;
  /** Optional Wrangler environment name (e.g. `"staging"`). */
  env?: string;
  /** Optional explicit path to `wrangler.jsonc` / `wrangler.json` / `wrangler.toml`. */
  wranglerConfig?: string;
  /** Optional project root directory used to locate wrangler config when `wranglerConfig` is omitted. */
  root?: string;
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
  const opened = await openWranglerD1({
    remote: opts.remote,
    binding: opts.binding,
    env: opts.env,
    wranglerConfig: opts.wranglerConfig,
    root: opts.root,
    logger: opts.config.logger,
  });

  try {
    const contrail = new Contrail({
      ...opts.config,
      lexicons: opts.lexicons,
    });
    await contrail.init(opened.db);
    return await fn(contrail, opened.db);
  } finally {
    await opened.dispose();
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
  /** How old the service's snapshot may be before the export is refused. */
  maxAgeUs?: number;
  /** Permit HTTP to a non-loopback endpoint. Default: false. */
  allowInsecureHttp?: boolean;
  /** How old an unfinished bootstrap's snapshot may be before it is refused
   * instead of resumed. Keep it inside the live service's retention. */
  replayWindowUs?: number;
  transport?: AlluviumTransportOptions;
  /** Build the record tables' secondary indexes once after the load
   * instead of maintaining them per row. Use for a local SQLite file; leave
   * off for D1, where one statement cannot index a large table in time. */
  deferIndexes?: boolean;
  /** Override chunk size for derived-projection rebuilds (default: 500 when
   * `deferIndexes` is false, bulk when `deferIndexes` is true). */
  rebuildChunkSize?: number;
  /** Optional progress callback invoked during loading and projection rebuild. */
  onProgress?: (progress: AlluviumProgress) => void;
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
  /** The cursor live ingestion reads next. After a completed bootstrap has
   * handed off, this is wherever live ingestion has got to. */
  liveCursor: number;
  resumed: boolean;
  /** An earlier run had already completed this bootstrap; nothing was loaded. */
  alreadyComplete: boolean;
}

async function runAlluviumBootstrap(
  contrail: Contrail,
  db: Database,
  opts: AlluviumBootstrapOptions,
): Promise<AlluviumBootstrapResult> {
  const ordered = contrail.config.orderedSource;
  const source =
    opts.sourceId !== undefined || opts.sourceEpoch !== undefined
      ? {
          id: opts.sourceId ?? ordered?.source ?? "jetstream",
          epoch: opts.sourceEpoch ?? ordered?.epoch ?? "alluvium-export",
        }
      : undefined;
  const started = performance.now();
  const result = await loadAlluviumExport(db, contrail.config, {
    endpoint: opts.endpoint,
    token: opts.token,
    source,
    rewindUs: opts.rewindUs,
    maxAgeUs: opts.maxAgeUs,
    allowInsecureHttp: opts.allowInsecureHttp,
    replayWindowUs: opts.replayWindowUs,
    transport: opts.transport,
    deferIndexes: opts.deferIndexes === true,
    rebuildChunkSize: opts.rebuildChunkSize,
    onProgress: opts.onProgress,
  });
  return {
    elapsedMs: Math.round(performance.now() - started),
    handoff: result.handoff,
    liveCursor: result.liveCursor,
    resumed: result.resumed,
    alreadyComplete: result.alreadyComplete,
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
