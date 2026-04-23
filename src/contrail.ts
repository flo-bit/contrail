import type { ContrailConfig, Database, ResolvedContrailConfig } from "./core/types";
import { resolveConfig, validateConfig } from "./core/types";
import { initSchema } from "./core/db/schema";
import { queryRecords } from "./core/db/records";
import type { QueryOptions, SortOption } from "./core/db/records";
import { runIngestCycle, createIngestState } from "./core/jetstream";
import type { IngestState } from "./core/jetstream";
import { discoverDIDs, backfillAll } from "./core/backfill";
import type { BackfillAllOptions, BackfillProgress } from "./core/backfill";
import { processNotifyUris } from "./core/router/notify";
import type { NotifyResult } from "./core/router/notify";
import { runPersistent as runPersistentIngestion } from "./core/persistent";
import type { PersistentIngestOptions } from "./core/persistent";
import type { PubSub } from "./core/realtime/types";
import { InMemoryPubSub } from "./core/realtime/in-memory";
import { createApp, type CreateAppOptions } from "./core/router";
import type { Hono } from "hono";

export interface ContrailOptions extends ContrailConfig {
  db?: Database;
  /** Optional separate DB for permissioned spaces tables. Defaults to `db`. */
  spacesDb?: Database;
}

export class Contrail {
  readonly config: ResolvedContrailConfig;
  private _db?: Database;
  private _spacesDb?: Database;
  private _ingestState: IngestState = createIngestState();
  private _pubsub: PubSub | null = null;

  constructor(options: ContrailOptions) {
    const { db, spacesDb, ...configInput } = options;
    this.config = resolveConfig(configInput);
    validateConfig(this.config);
    this._db = db;
    this._spacesDb = spacesDb;
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
    await initSchema(main, this.config, { spacesDb: spaces });
  }

  /** Query records from a collection. */
  async query(
    collection: string,
    options?: Omit<QueryOptions, "collection">,
    db?: Database
  ) {
    return queryRecords(this.getDb(db), this.config, { collection, ...options });
  }

  /** Run one Jetstream ingestion cycle (catches up to present, then stops). */
  async ingest(options?: { timeoutMs?: number }, db?: Database): Promise<void> {
    await runIngestCycle(
      this.getDb(db),
      this.config,
      options?.timeoutMs,
      this._ingestState,
      this._pubsub ?? undefined
    );
  }

  /** Run persistent Jetstream ingestion (long-lived, stays connected). */
  async runPersistent(options?: Omit<PersistentIngestOptions, 'logger'>, db?: Database): Promise<void> {
    await runPersistentIngestion(this.getDb(db), this.config, {
      ...options,
      logger: this.config.logger,
      pubsub: this._pubsub ?? undefined,
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
    return backfillAll(this.getDb(db), this.config, options);
  }

  /** Discover + backfill in one call. */
  async sync(
    options?: BackfillAllOptions,
    db?: Database
  ): Promise<{ discovered: number; backfilled: number }> {
    const d = this.getDb(db);
    const discovered = await this.discover(d);
    const backfilled = await this.backfill(options, d);
    return { discovered: discovered.length, backfilled };
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
