import type { ContrailConfig, Database, ResolvedContrailConfig } from "./core/types";
import { resolveConfig, validateConfig } from "./core/types";
import { initSchema } from "./core/db/schema";
import { queryRecords } from "./core/db/records";
import type { QueryOptions, SortOption } from "./core/db/records";
import { runIngestCycle, createIngestState } from "./core/jetstream";
import type { IngestState } from "./core/jetstream";
import { discoverDIDs, backfillPending } from "./core/backfill";
import type { BackfillAllOptions, BackfillProgress } from "./core/backfill";
import { refresh as runRefresh } from "./core/refresh";
import type { RefreshOptions, RefreshResult } from "./core/refresh";
import { processNotifyUris } from "./core/router/notify";
import type { NotifyResult } from "./core/router/notify";
import { runPersistent as runPersistentIngestion } from "./core/persistent";
import type { PersistentIngestOptions } from "./core/persistent";
import {
  runLabelIngestCycle,
  runPersistentLabels as runPersistentLabelsImpl,
  type PersistentLabelsOptions,
} from "./core/labels/subscribe";
import type { PubSub } from "./core/realtime/types";
import { InMemoryPubSub } from "./core/realtime/in-memory";
import { createApp, type CreateAppOptions } from "./core/router";
import type { CommunityIntegration } from "./core/community-integration";
import type { Hono } from "hono";

/** Note: `community` is shadowed from ContrailConfig (where it's the
 *  user-supplied config blob, typed as `unknown`) to be the pre-built
 *  integration object the Contrail instance actually consumes. */
export interface ContrailOptions extends Omit<ContrailConfig, "community"> {
  db?: Database;
  /** Optional separate DB for permissioned spaces tables. Defaults to `db`. */
  spacesDb?: Database;
  /** Optional user-supplied community config blob. Same shape as
   *  ContrailConfig.community — the community integration reads this
   *  via `config.community`. */
  community?: unknown;
  /** Optional pre-built community integration. When set, the Contrail
   *  instance applies its schema during `init()` and forwards it to
   *  `createApp` so community routes / hooks are wired automatically.
   *  Construct via `createCommunityIntegration(...)` from
   *  `@atmo-dev/contrail-community`. */
  communityIntegration?: CommunityIntegration;
}

export class Contrail {
  readonly config: ResolvedContrailConfig;
  private _db?: Database;
  private _spacesDb?: Database;
  private _community?: CommunityIntegration;
  private _ingestState: IngestState = createIngestState();
  private _pubsub: PubSub | null = null;

  constructor(options: ContrailOptions) {
    const { db, spacesDb, communityIntegration, ...configInput } = options;
    this.config = resolveConfig(configInput as ContrailConfig);
    validateConfig(this.config);
    this._db = db;
    this._spacesDb = spacesDb;
    this._community = communityIntegration;
    // Build the pubsub instance up-front so ingestion and HTTP routes share
    // it. Caller overrides via `config.realtime.pubsub` (e.g. DurableObject).
    if (this.config.realtime) {
      this._pubsub =
        this.config.realtime.pubsub ??
        new InMemoryPubSub({ queueBound: this.config.realtime.queueBound });
    }
  }

  /** The shared realtime pubsub, or null when realtime isn't configured. */
  get pubsub(): PubSub | null {
    return this._pubsub;
  }

  private getDb(db?: Database): Database {
    const d = db ?? this._db;
    if (!d) throw new Error("No database provided. Pass db to constructor or to this method.");
    return d;
  }

  /** Returns the configured spaces DB (or the main DB if not separately configured). */
  getSpacesDb(db?: Database, spacesDb?: Database): Database {
    return spacesDb ?? this._spacesDb ?? this.getDb(db);
  }

  /** Initialize the database schema. Must be called before other operations.
   *  If a separate spacesDb is configured, its tables are initialized on it. */
  async init(db?: Database, spacesDb?: Database): Promise<void> {
    const main = this.getDb(db);
    const spaces = spacesDb ?? this._spacesDb;
    const extraSchemas = this._community ? [this._community.applySchema] : [];
    await initSchema(main, this.config, { spacesDb: spaces, extraSchemas });
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
      runIngestCycle(d, this.config, options?.timeoutMs, this._ingestState, this._pubsub ?? undefined),
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
        pubsub: this._pubsub ?? undefined,
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

  /** Discover every DID with records in the configured collections, then
   *  backfill their history. Logs progress via `config.logger` — supply
   *  `onProgress` to take over output, or pass a no-op logger in the config
   *  to silence the defaults. */
  async backfillAll(
    options?: BackfillAllOptions,
    db?: Database
  ): Promise<{ discovered: number; backfilled: number }> {
    const d = this.getDb(db);
    const logger = this.config.logger;
    const startedAt = Date.now();

    logger?.log?.("discovering users…");
    const discovered = await this.discover(d);
    logger?.log?.(`  discovered ${discovered.length} users`);

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

    logger?.log?.("backfilling…");
    const backfilled = await this.backfill(effective, d);
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger?.log?.(
      `  done: ${backfilled} records across ${discovered.length} users in ${elapsedS}s`
    );
    return { discovered: discovered.length, backfilled };
  }

  /** Fresh sweep: re-walk every known DID's PDS, compare each record against
   *  our DB, count anything missing or stale (outside the ignore window).
   *  Apply the deltas. Returns stats per-collection + totals.
   *
   *  Progress logs via `config.logger` unless `onProgress` is supplied. */
  async refresh(
    options?: RefreshOptions,
    db?: Database
  ): Promise<RefreshResult> {
    const d = this.getDb(db);
    const logger = this.config.logger;

    let effective = options;
    if (!options?.onProgress) {
      let lastLogAt = 0;
      effective = {
        ...options,
        onProgress: ({ usersComplete, usersTotal, usersFailed, recordsScanned }) => {
          const now = Date.now();
          if (now - lastLogAt < 2_000) return;
          lastLogAt = now;
          const failStr = usersFailed > 0 ? `, ${usersFailed} failed` : "";
          logger?.log?.(
            `  ${recordsScanned} records scanned | ${usersComplete}/${usersTotal} users${failStr}`
          );
        },
      };
    }

    logger?.log?.("refreshing…");
    const result = await runRefresh(d, this.config, effective);
    const elapsedS = (result.elapsedMs / 1000).toFixed(1);
    logger?.log?.(
      `  done: ${result.total.missing} missing, ${result.total.staleUpdates} stale updates ` +
        `across ${result.usersScanned} users in ${elapsedS}s` +
        (result.usersFailed > 0 ? ` (${result.usersFailed} failed)` : "")
    );
    return result;
  }

  /** Immediately fetch and index specific records from their PDS. */
  async notify(
    uris: string | string[],
    db?: Database
  ): Promise<NotifyResult> {
    const uriList = Array.isArray(uris) ? uris : [uris];
    return processNotifyUris(this.getDb(db), this.config, uriList);
  }

  /** Build the Hono app for this Contrail instance. All HTTP routes
   *  (collection / spaces / community / realtime) are registered here.
   *  The realtime pubsub on this instance is reused, so subscribers see
   *  events published from `ingest()` / `runPersistent()` on the same instance. */
  app(options: AppOptions = {}): Hono {
    const { db, ...appOpts } = options;
    const main = this.getDb(db);
    const spaces = options.spacesDb ?? this._spacesDb;
    return createApp(main, this.config, {
      ...appOpts,
      spacesDb: spaces,
      // Per-call community override falls back to the constructor's.
      community: appOpts.community ?? this._community ?? null,
      realtime: { ...appOpts.realtime, pubsub: this._pubsub ?? undefined },
    });
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
