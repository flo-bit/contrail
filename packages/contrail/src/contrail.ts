import type {
  ContrailConfig,
  Database,
  ResolvedContrailConfig,
} from "./core/types";
import {
  optimizeAnalysisLimit,
  resolveConfig,
  validateConfig,
} from "./core/types";
import { initSchema } from "./core/db/schema";
import { prepareRecordValidation } from "./core/validation";
import { getIngestDiagnostics } from "./core/diagnostics";
import { optimizeDatabase } from "./core/db/optimize";
import { queryRecords, type QueryOptions } from "./core/db/records";
import {
  createIngestState,
  runIngestCycle,
  type IngestState,
} from "./core/jetstream";
import {
  backfillPending,
  discoverAndBackfill,
  discoverDIDs,
  retryPendingBackfills,
  type BackfillAllOptions,
  type BackfillRetryOptions,
  type BackfillRetryResult,
} from "./core/backfill";
import { getBackfillStatus, type BackfillStatus } from "./core/status";
import {
  processNotifyUris,
  type NotifyResult,
} from "./core/router/notify";
import {
  runPersistent as runPersistentIngestion,
  type PersistentIngestOptions,
} from "./core/persistent";
import {
  runLabelIngestCycle,
  runPersistentLabels as runPersistentLabelsImpl,
  type PersistentLabelsOptions,
} from "./core/labels/subscribe";
import { createApp, type CreateAppOptions } from "./core/router";
import type { Hono } from "hono";

export interface ContrailOptions extends ContrailConfig {
  db?: Database;
}

export class Contrail {
  readonly config: ResolvedContrailConfig;
  private _db?: Database;
  private _ingestState: IngestState = createIngestState();

  constructor(options: ContrailOptions) {
    const { db, ...configInput } = options;
    this.config = resolveConfig(configInput);
    validateConfig(this.config);
    prepareRecordValidation(this.config);
    this._db = db;
  }

  private getDb(db?: Database): Database {
    const d = db ?? this._db;
    if (!d) throw new Error("No database provided. Pass db to constructor or to this method.");
    return d;
  }

  /** Initialize the database schema. */
  async init(db?: Database): Promise<void> {
    await initSchema(this.getDb(db), this.config);
  }

  /** Refresh the SQLite query-planner statistics (bounded `PRAGMA optimize`) so
   *  multi-predicate queries pick the selective index. No-op on Postgres. Safe
   *  to call on a schedule; the ingest tick runs this automatically when
   *  `config.maintenance.optimize` is enabled, so most consumers don't need to
   *  call it directly. */
  async optimize(db?: Database): Promise<void> {
    await optimizeDatabase(this.getDb(db), optimizeAnalysisLimit(this.config));
  }

  /** Read private aggregate ingest rejection counters. */
  async diagnostics(db?: Database) {
    return getIngestDiagnostics(this.getDb(db));
  }

  /** Query records from a collection. */
  async query(
    collection: string,
    options?: Omit<QueryOptions, "collection">,
    db?: Database
  ) {
    return queryRecords(this.getDb(db), this.config, { collection, ...options });
  }

  /** Run one ingestion cycle: catches up records from Jetstream and — when
   *  `config.labels` is set — labels from each configured labeler in parallel.
   *  Both share the same `timeoutMs` budget; they're independent network
   *  operations so concurrency is free. */
  async ingest(options?: { timeoutMs?: number }, db?: Database): Promise<void> {
    const d = this.getDb(db);
    const tasks: Promise<void>[] = [
      runIngestCycle(d, this.config, options?.timeoutMs, this._ingestState),
    ];
    if (this.config.labels) {
      tasks.push(runLabelIngestCycle(d, this.config, options?.timeoutMs));
    }
    await Promise.all(tasks);
  }

  /** Long-lived ingestion: streams records via Jetstream and — when
   *  `config.labels` is set — labels via per-labeler `subscribeLabels` sockets.
   *  Both honor the supplied `signal` and shut down cleanly together. */
  async runPersistent(options?: Omit<PersistentIngestOptions, 'logger'>, db?: Database): Promise<void> {
    const d = this.getDb(db);
    const tasks: Promise<void>[] = [
      runPersistentIngestion(d, this.config, {
        ...options,
        logger: this.config.logger,
      }),
    ];
    if (this.config.labels) {
      tasks.push(
        runPersistentLabelsImpl(d, this.config, {
          signal: options?.signal,
          batchSize: options?.batchSize,
          flushIntervalMs: options?.flushIntervalMs,
          logger: this.config.logger,
        }),
      );
    }
    await Promise.all(tasks);
  }

  /** Run *only* the labeler ingestion cycle. Escape hatch for callers who
   *  want to run record and label ingestion in separate processes / workers.
   *  `ingest()` already covers the typical case. */
  async ingestLabels(
    options?: { timeoutMs?: number },
    db?: Database,
  ): Promise<void> {
    if (!this.config.labels) return;
    await runLabelIngestCycle(this.getDb(db), this.config, options?.timeoutMs);
  }

  /** Run *only* the persistent labeler ingestion. Escape hatch counterpart
   *  to `ingestLabels()`. `runPersistent()` covers the typical case. */
  async runPersistentLabels(
    options?: Omit<PersistentLabelsOptions, "logger">,
    db?: Database,
  ): Promise<void> {
    if (!this.config.labels) return;
    await runPersistentLabelsImpl(this.getDb(db), this.config, {
      ...options,
      logger: this.config.logger,
    });
  }

  /** Discover users from relays. Returns discovered DIDs. */
  async discover(db?: Database): Promise<string[]> {
    const d = this.getDb(db);
    const allDiscovered = new Set<string>();
    while (true) {
      const dids = await discoverDIDs(d, this.config, Infinity);
      if (dids.length === 0) break;
      for (const did of dids) allDiscovered.add(did);
    }
    return [...allDiscovered];
  }

  /** Backfill pending users' records from their PDS. */
  async backfill(
    options?: BackfillAllOptions,
    db?: Database
  ): Promise<number> {
    return backfillPending(this.getDb(db), this.config, options);
  }

  /** Retry a bounded slice of due or interrupted account backfills. Intended
   *  for scheduled runtimes; persisted backoff prevents hammering failures. */
  async retryBackfill(
    options?: BackfillRetryOptions,
    db?: Database
  ): Promise<BackfillRetryResult> {
    return retryPendingBackfills(this.getDb(db), this.config, options);
  }

  /** Discover every DID with records in the configured collections, then
   *  backfill their history. Logs progress via `config.logger` — supply
   *  `onProgress` to take over output, or pass a no-op logger in the config
   *  to silence the defaults. */
  async backfillAll(
    options?: BackfillAllOptions,
    db?: Database
  ): Promise<{
    discovered: number;
    backfilled: number;
    status: BackfillStatus;
  }> {
    const d = this.getDb(db);
    const logger = this.config.logger;
    const startedAt = Date.now();

    // Wrap the call with a throttled default progress logger when the
    // caller hasn't supplied their own. Throttle at 2s so we don't spam in
    // fast/local runs; final summary always prints.
    let effective = options;
    if (!options?.onProgress) {
      let lastLogAt = 0;
      effective = {
        ...options,
        onProgress: ({ records, usersComplete, usersTotal, usersFailed }) => {
          const now = Date.now();
          if (now - lastLogAt < 2_000) return;
          lastLogAt = now;
          const failStr = usersFailed > 0 ? `, ${usersFailed} failed` : "";
          logger?.log?.(
            `  ${records} records | ${usersComplete}/${usersTotal} users${failStr}`
          );
        },
      };
    }

    logger?.log?.("discovering users…");
    const result = await discoverAndBackfill(
      d,
      this.config,
      effective,
      (count) => {
        logger?.log?.(`  discovered ${count} users`);
        logger?.log?.("backfilling…");
      }
    );
    const discovered = result.discovered;
    const backfilled = result.backfilled;

    const status = await getBackfillStatus(d, this.config);
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    const unresolved = status.accounts.retrying + status.accounts.failed;
    if (status.state === "complete" && unresolved > 0) {
      logger?.warn?.(
        `  done with deferred failures: ${status.accounts.complete}/${status.accounts.total} known accounts complete; ${status.accounts.retrying} retrying, ${status.accounts.failed} exhausted (${elapsedS}s)`
      );
    } else if (status.state === "complete") {
      logger?.log?.(
        `  done: ${backfilled} records; ${status.accounts.complete}/${status.accounts.total} known accounts complete in ${elapsedS}s`
      );
    } else {
      logger?.warn?.(
        `  interrupted: ${status.accounts.pending} known accounts still need an initial attempt (${elapsedS}s)`
      );
    }
    return { discovered: discovered.length, backfilled, status };
  }

  /** Immediately fetch and index specific records from their PDS. */
  async notify(
    uris: string | string[],
    db?: Database
  ): Promise<NotifyResult> {
    const uriList = Array.isArray(uris) ? uris : [uris];
    return processNotifyUris(this.getDb(db), this.config, uriList);
  }

  /** Build the Hono app for this Contrail instance. */
  app(options: AppOptions = {}): Hono {
    const { db, ...appOptions } = options;
    return createApp(this.getDb(db), this.config, appOptions);
  }

  /** Fetch-style handler built from `app()`. Use this from SvelteKit / Next /
   *  Workers / Bun — anything that takes `(request) => Response`. */
  handler(options: AppOptions = {}): (request: Request) => Promise<Response> {
    const app = this.app(options);
    return (request: Request) => app.fetch(request) as Promise<Response>;
  }
}

/** Overrides accepted by `Contrail.app()` and `Contrail.handler()`. Mirrors
 *  `CreateAppOptions` but lets the caller also override the DBs (falling back
 *  to the ones given to the Contrail constructor). */
export interface AppOptions extends CreateAppOptions {
  db?: Database;
}
