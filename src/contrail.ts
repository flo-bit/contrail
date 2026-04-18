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

  constructor(options: ContrailOptions) {
    const { db, spacesDb, ...configInput } = options;
    this.config = resolveConfig(configInput);
    validateConfig(this.config);
    this._db = db;
    this._spacesDb = spacesDb;
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
    await runIngestCycle(this.getDb(db), this.config, options?.timeoutMs, this._ingestState);
  }

  /** Run persistent Jetstream ingestion (long-lived, stays connected). */
  async runPersistent(options?: Omit<PersistentIngestOptions, 'logger'>, db?: Database): Promise<void> {
    await runPersistentIngestion(this.getDb(db), this.config, { ...options, logger: this.config.logger });
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
}
