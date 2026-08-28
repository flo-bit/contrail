import type { SqlDialect } from "./dialect";
import type {
  ContrailConfig,
  Database,
  IngestEvent,
  ProjectionPhase,
  Statement,
} from "./types";
import {
  canonicalChangeDefinitions,
  changeConsumerPhases,
  changeLogCoverage,
  changesEnabled,
} from "./types";

export const MAX_CHANGE_BATCH_CHANGES = 500;
export const MAX_CHANGE_BATCH_BYTES = 512_000;

export interface ChangeLogCostPlan {
  enabled: boolean;
  consumers: number;
  coveragePairs: number;
  projectionStateWrites: number;
  changeHeadWrites: number;
  changeBatchWrites: number;
  acknowledgementWrites: number;
  /** Total expected rows written by one relevant projection transaction. */
  relevantProjectionWrites: number;
}

/** Conservative write-amplification report for one bounded projection batch. */
export function getChangeLogCostPlan(
  config: ContrailConfig,
  mutationUris = 50,
): ChangeLogCostPlan {
  if (!Number.isSafeInteger(mutationUris) || mutationUris < 1 || mutationUris > 500) {
    throw new TypeError("mutationUris must be an integer between 1 and 500");
  }
  const enabled = changesEnabled(config);
  // One serialized revision update plus one predecessor-check update per forty
  // unique URIs. The idempotent singleton INSERT normally writes no row.
  const projectionStateWrites = 1 + Math.ceil(mutationUris / 40);
  const changeHeadWrites = enabled ? 1 : 0;
  const changeBatchWrites = enabled ? 1 : 0;
  return {
    enabled,
    consumers: Object.keys(config.changes?.consumers ?? {}).length,
    coveragePairs: changeLogCoverage(config).length,
    projectionStateWrites,
    changeHeadWrites,
    changeBatchWrites,
    acknowledgementWrites: enabled ? 1 : 0,
    relevantProjectionWrites:
      projectionStateWrites + changeHeadWrites + changeBatchWrites,
  };
}

export interface RecordChange {
  id: string;
  kind: "record";
  operation: "put" | "delete";
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string | null;
  version: {
    sourceId: string;
    sourceEpoch: string | null;
    sourceRevision: string | null;
    sourceTimeUs: number;
    sourceCursor: string | null;
  };
}

type StoredRecordChange = Omit<RecordChange, "id">;

export interface ChangeLogState {
  generation: string;
  head: string;
  retainedFloor: string;
  createdAt: number;
}

interface ChangeLogStateRow {
  generation_id: string;
  head_position: number | string;
  retained_floor_position: number | string;
  definitions_json: string;
  created_at: number | string;
}

interface ChangeConsumerRow {
  consumer_id: string;
  generation_id: string;
  acknowledged_position: number | string;
  configured_collections_json: string;
  configured_phases_json: string;
  initial_mode: string;
  required_for_activation: number | string;
  bootstrap_state: string;
  bootstrap_anchor_position: number | string | null;
}

interface ChangeCoverageRow {
  generation_id: string;
  collection: string;
  phase: ProjectionPhase;
  from_position: number | string;
  through_position: number | string | null;
}

export interface ChangeLogSchemaProbe {
  exists: boolean;
  state: ChangeLogStateRow | null;
}

/** Optional physical schema. It is absent when no consumers are configured. */
export function buildChangeLogSchema(
  config: ContrailConfig,
  dialect: SqlDialect,
): string[] {
  if (!changesEnabled(config)) return [];
  const bigint = dialect.bigintType;
  return [
    `CREATE TABLE IF NOT EXISTS change_log_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generation_id TEXT NOT NULL,
      head_position ${bigint} NOT NULL,
      retained_floor_position ${bigint} NOT NULL,
      definitions_json TEXT NOT NULL,
      created_at ${bigint} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS change_batches (
      generation_id TEXT NOT NULL,
      position ${bigint} NOT NULL,
      projection_transaction_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_epoch TEXT,
      source_cursor TEXT,
      phase TEXT NOT NULL CHECK (phase IN ('historical', 'live')),
      changes_json TEXT NOT NULL,
      change_count INTEGER NOT NULL,
      encoded_bytes INTEGER NOT NULL,
      created_at ${bigint} NOT NULL,
      PRIMARY KEY (generation_id, position)
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_change_batches_transaction ON change_batches(generation_id, projection_transaction_id)",
    "CREATE INDEX IF NOT EXISTS idx_change_batches_created ON change_batches(generation_id, created_at)",
    `CREATE TABLE IF NOT EXISTS change_consumers (
      consumer_id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      acknowledged_position ${bigint} NOT NULL,
      configured_collections_json TEXT NOT NULL,
      configured_phases_json TEXT NOT NULL,
      initial_mode TEXT NOT NULL CHECK (initial_mode IN ('current', 'future', 'history')),
      required_for_activation INTEGER NOT NULL DEFAULT 0,
      bootstrap_state TEXT NOT NULL CHECK (bootstrap_state IN ('pending', 'scanning', 'catching-up', 'activating', 'ready', 'error', 'reset-required')),
      bootstrap_anchor_position ${bigint},
      bootstrap_scan_collection TEXT,
      bootstrap_scan_cursor TEXT,
      bootstrap_target_position ${bigint},
      bootstrap_token TEXT,
      lease_owner TEXT,
      lease_expires_at ${bigint},
      lease_through_position ${bigint},
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at ${bigint},
      last_success_at ${bigint},
      last_error_code TEXT,
      last_error_at ${bigint},
      updated_at ${bigint} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS change_log_coverage (
      generation_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('historical', 'live')),
      from_position ${bigint} NOT NULL,
      through_position ${bigint},
      PRIMARY KEY (generation_id, collection, phase, from_position)
    )`,
    `CREATE TABLE IF NOT EXISTS change_consumer_actions (
      action_id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('skip', 'remove')),
      from_position ${bigint} NOT NULL,
      through_position ${bigint} NOT NULL,
      reason TEXT NOT NULL,
      created_at ${bigint} NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_change_consumer_actions_consumer ON change_consumer_actions(generation_id, consumer_id, created_at)",
  ];
}

function missingTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === "42P01") return true;
  return /no such table|does not exist/i.test(
    String((error as { message?: unknown }).message ?? ""),
  );
}

export async function probeChangeLogSchema(
  db: Database,
): Promise<ChangeLogSchemaProbe> {
  try {
    const state = await db
      .prepare(
        `SELECT generation_id, head_position, retained_floor_position,
                definitions_json, created_at
         FROM change_log_state WHERE id = 1`,
      )
      .first<ChangeLogStateRow>();
    return { exists: true, state };
  } catch (error) {
    if (missingTable(error)) return { exists: false, state: null };
    throw error;
  }
}

/** Enabling the first log without an old-writer quiet boundary is supported
 * only on an empty projection generation in this milestone. */
export async function assertFreshChangeLogGeneration(
  db: Database,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM record_versions LIMIT 1) OR
         EXISTS (SELECT 1 FROM cursor LIMIT 1) OR
         EXISTS (SELECT 1 FROM source_position LIMIT 1) OR
         EXISTS (SELECT 1 FROM bootstrap_state LIMIT 1) OR
         EXISTS (SELECT 1 FROM backfills LIMIT 1) OR
         EXISTS (SELECT 1 FROM discovery LIMIT 1) OR
         EXISTS (SELECT 1 FROM identities LIMIT 1)
       THEN 1 ELSE 0 END AS active`,
    )
    .first<{ active: number | string }>();
  if (Number(row?.active ?? 0) !== 0) {
    throw new Error(
      "Transactional change logging can currently be enabled only on a fresh empty generation; build a fresh generation instead of racing existing projection writers",
    );
  }
}

function canonicalCollections(collections: string[]): string {
  return JSON.stringify([...collections].sort());
}

function canonicalPhases(phases: ProjectionPhase[]): string {
  return JSON.stringify([...phases].sort());
}

function sameStaticConsumer(
  actual: ChangeConsumerRow,
  expected: NonNullable<ContrailConfig["changes"]>["consumers"][string],
): boolean {
  return (
    actual.configured_collections_json ===
      canonicalCollections(expected.collections) &&
    actual.configured_phases_json ===
      canonicalPhases(changeConsumerPhases(expected)) &&
    actual.initial_mode === expected.initial &&
    Number(actual.required_for_activation) ===
      (expected.requiredForActivation === true ? 1 : 0)
  );
}

/** Reconcile only additive consumers whose collection/phase coverage is already
 * durable. Expanding coverage still requires a fresh generation or an explicit
 * old-writer quiet boundary. */
async function reconcileAdditiveDefinitions(
  db: Database,
  config: ContrailConfig,
  state: ChangeLogStateRow,
  definitions: string,
): Promise<void> {
  const durableConsumers = await db
    .prepare(
      `SELECT consumer_id, generation_id, acknowledged_position,
              configured_collections_json, configured_phases_json, initial_mode,
              required_for_activation, bootstrap_state,
              bootstrap_anchor_position
       FROM change_consumers ORDER BY consumer_id`,
    )
    .all<ChangeConsumerRow>();
  const configured = config.changes?.consumers ?? {};
  for (const durable of durableConsumers.results) {
    const expected = configured[durable.consumer_id];
    if (!expected || !sameStaticConsumer(durable, expected)) {
      throw new Error(
        "Durable change consumers cannot be removed or modified during ordinary initialization",
      );
    }
  }

  const coverage = await db
    .prepare(
      `SELECT generation_id, collection, phase, from_position, through_position
       FROM change_log_coverage
       WHERE generation_id = ? AND through_position IS NULL
       ORDER BY collection, phase, from_position`,
    )
    .bind(state.generation_id)
    .all<ChangeCoverageRow>();
  const durablePairs = new Set(
    coverage.results.map((item) => `${item.collection}\0${item.phase}`),
  );
  const expectedPairs = changeLogCoverage(config);
  if (
    durablePairs.size !== expectedPairs.length ||
    expectedPairs.some(
      (item) => !durablePairs.has(`${item.collection}\0${item.phase}`),
    )
  ) {
    throw new Error(
      "Adding this change consumer expands collection/phase coverage; use a fresh generation or an explicit quiet-boundary migration",
    );
  }

  await db
    .prepare(
      `UPDATE change_log_state SET definitions_json = ?
       WHERE id = 1 AND generation_id = ? AND definitions_json = ?`,
    )
    .bind(definitions, state.generation_id, state.definitions_json)
    .run();
  const updated = (await probeChangeLogSchema(db)).state;
  if (!updated || updated.definitions_json !== definitions) {
    throw new Error("Change consumer definitions changed concurrently");
  }
}

/** Initialize the fresh log or safely add consumers over already-logged
 * collection/phase coverage. */
export async function initializeChangeLog(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  if (!changesEnabled(config)) return;

  const definitions = canonicalChangeDefinitions(config);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO change_log_state
       (id, generation_id, head_position, retained_floor_position,
        definitions_json, created_at)
       VALUES (1, ?, 0, 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), definitions, now)
    .run();

  let state = (await probeChangeLogSchema(db)).state;
  if (!state) throw new Error("Could not initialize change-log state");
  if (state.definitions_json !== definitions) {
    await reconcileAdditiveDefinitions(db, config, state, definitions);
    state = (await probeChangeLogSchema(db)).state;
    if (!state) throw new Error("Could not reload change-log state");
  }

  const statements: Statement[] = [];
  for (const [consumerId, consumer] of Object.entries(
    config.changes?.consumers ?? {},
  ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const initialReady = consumer.initial === "current" ? "pending" : "ready";
    statements.push(
      db
        .prepare(
          `INSERT INTO change_consumers
           (consumer_id, generation_id, acknowledged_position,
            configured_collections_json, configured_phases_json, initial_mode,
            required_for_activation, bootstrap_state,
            bootstrap_anchor_position, bootstrap_token, attempts, updated_at)
           SELECT ?, generation_id,
                  CASE WHEN ? = 'history' THEN retained_floor_position
                       ELSE head_position END,
                  ?, ?, ?, ?, ?,
                  CASE WHEN ? = 'current' THEN head_position ELSE NULL END,
                  CASE WHEN ? = 'current' THEN ? ELSE NULL END,
                  0, ?
           FROM change_log_state
           WHERE id = 1 AND definitions_json = ?
           ON CONFLICT(consumer_id) DO NOTHING`,
        )
        .bind(
          consumerId,
          consumer.initial,
          canonicalCollections(consumer.collections),
          canonicalPhases(changeConsumerPhases(consumer)),
          consumer.initial,
          consumer.requiredForActivation === true ? 1 : 0,
          initialReady,
          consumer.initial,
          consumer.initial,
          crypto.randomUUID(),
          now,
          definitions,
        ),
    );
  }

  for (const item of changeLogCoverage(config)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO change_log_coverage
           (generation_id, collection, phase, from_position, through_position)
           SELECT generation_id, ?, ?, 0, NULL
           FROM change_log_state
           WHERE id = 1 AND definitions_json = ?
           ON CONFLICT(generation_id, collection, phase, from_position)
           DO NOTHING`,
        )
        .bind(item.collection, item.phase, definitions),
    );
  }

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  await assertChangeLogDefinition(db, config);
}

async function assertChangeLogDefinition(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  const state = (await probeChangeLogSchema(db)).state;
  const definitions = canonicalChangeDefinitions(config);
  if (!state || state.definitions_json !== definitions) {
    throw new Error(
      "Durable change consumer definitions differ from configuration; changing consumers or coverage requires a fresh generation in this milestone",
    );
  }

  const consumers = await db
    .prepare(
      `SELECT consumer_id, generation_id, acknowledged_position,
              configured_collections_json, configured_phases_json, initial_mode,
              required_for_activation, bootstrap_state,
              bootstrap_anchor_position
       FROM change_consumers ORDER BY consumer_id`,
    )
    .all<ChangeConsumerRow>();
  const expectedConsumers = Object.entries(config.changes?.consumers ?? {});
  if (consumers.results.length !== expectedConsumers.length) {
    throw new Error("Durable change consumer registration is incomplete");
  }
  const consumersById = new Map(
    consumers.results.map((consumer) => [consumer.consumer_id, consumer]),
  );
  for (const [id, expected] of expectedConsumers) {
    const actual = consumersById.get(id);
    if (
      !actual ||
      actual.generation_id !== state.generation_id ||
      actual.configured_collections_json !== canonicalCollections(expected.collections) ||
      actual.configured_phases_json !== canonicalPhases(changeConsumerPhases(expected)) ||
      actual.initial_mode !== expected.initial ||
      Number(actual.required_for_activation) !==
        (expected.requiredForActivation === true ? 1 : 0)
    ) {
      throw new Error(`Durable change consumer ${id} is incompatible`);
    }
  }

  const coverage = await db
    .prepare(
      `SELECT generation_id, collection, phase, from_position, through_position
       FROM change_log_coverage
       ORDER BY collection, phase, from_position`,
    )
    .all<ChangeCoverageRow>();
  const expectedCoverage = changeLogCoverage(config);
  if (coverage.results.length !== expectedCoverage.length) {
    throw new Error("Durable change-log coverage is incomplete");
  }
  const coverageByPair = new Map(
    coverage.results.map((item) => [`${item.collection}\0${item.phase}`, item]),
  );
  for (const expected of expectedCoverage) {
    const actual = coverageByPair.get(`${expected.collection}\0${expected.phase}`);
    if (
      !actual ||
      actual.generation_id !== state.generation_id ||
      Number(actual.from_position) !== 0 ||
      actual.through_position !== null
    ) {
      throw new Error("Durable change-log coverage is incompatible");
    }
  }
}

export async function getChangeLogState(
  db: Database,
): Promise<ChangeLogState | null> {
  const probe = await probeChangeLogSchema(db);
  if (!probe.state) return null;
  return {
    generation: probe.state.generation_id,
    head: String(probe.state.head_position),
    retainedFloor: String(probe.state.retained_floor_position),
    createdAt: Number(probe.state.created_at),
  };
}

function bounded(value: string | null, label: string, maximum: number): void {
  if (value !== null && value.length > maximum) {
    throw new Error(`${label} exceeds ${maximum} characters`);
  }
}

function logicalChanges(
  events: IngestEvent[],
  existing: ReadonlyMap<string, { cid: string | null; record: string | null }>,
  config: ContrailConfig,
  phase: ProjectionPhase,
): StoredRecordChange[] {
  const covered = new Set(
    changeLogCoverage(config)
      .filter((item) => item.phase === phase)
      .map((item) => item.collection),
  );
  if (covered.size === 0) return [];

  // projectEvents already selects one source winner per URI. Keep this final
  // reduction defensive for direct internal callers.
  const final = new Map<string, IngestEvent>();
  for (const event of events) final.set(event.uri, event);

  const changes: StoredRecordChange[] = [];
  for (const event of final.values()) {
    if (!covered.has(event.collection)) continue;
    const prior = existing.get(event.uri);
    const deleted = event.operation === "delete";
    const visibleChange = deleted
      ? prior !== undefined
      : prior === undefined ||
        prior.cid !== event.cid ||
        (event.cid === null && prior.record !== event.record);
    if (!visibleChange) continue;

    const source = event.source;
    const change: StoredRecordChange = {
      kind: "record",
      operation: deleted ? "delete" : "put",
      uri: event.uri,
      did: event.did,
      collection: event.collection,
      rkey: event.rkey,
      cid: deleted ? null : event.cid,
      version: {
        sourceId: source?.id ?? "legacy-caller",
        sourceEpoch: source?.epoch ?? null,
        sourceRevision: source?.revision ?? null,
        sourceTimeUs: source?.time_us ?? event.time_us,
        sourceCursor: source?.cursor ?? null,
      },
    };
    bounded(change.uri, "change URI", 2_048);
    bounded(change.did, "change DID", 2_048);
    bounded(change.collection, "change collection", 512);
    bounded(change.rkey, "change rkey", 512);
    bounded(change.cid, "change CID", 512);
    bounded(change.version.sourceId, "change source ID", 128);
    bounded(change.version.sourceEpoch, "change source epoch", 256);
    bounded(change.version.sourceRevision, "change source revision", 2_048);
    bounded(change.version.sourceCursor, "change source cursor", 2_048);
    if (
      !Number.isSafeInteger(change.version.sourceTimeUs) ||
      change.version.sourceTimeUs < 0
    ) {
      throw new Error("change source time must be a non-negative safe integer");
    }
    changes.push(change);
  }
  return changes;
}

function commonValue(
  values: Array<string | null>,
): string | null {
  if (values.length === 0) return null;
  const first = values[0]!;
  return values.every((value) => value === first) ? first : null;
}

/** Statements appended after canonical/derived projection and before source
 * checkpoints in the same database transaction. */
export function appendChangeLogStatements(
  db: Database,
  events: IngestEvent[],
  existing: ReadonlyMap<string, { cid: string | null; record: string | null }>,
  config: ContrailConfig,
  phase: ProjectionPhase,
): Statement[] {
  if (!changesEnabled(config)) return [];
  const changes = logicalChanges(events, existing, config, phase);
  if (changes.length === 0) return [];
  if (changes.length > MAX_CHANGE_BATCH_CHANGES) {
    throw new Error(
      `Projection change batch contains ${changes.length} changes; maximum is ${MAX_CHANGE_BATCH_CHANGES}`,
    );
  }
  const serialized = JSON.stringify(changes);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_CHANGE_BATCH_BYTES) {
    throw new Error(
      `Projection change batch contains ${bytes} encoded bytes; maximum is ${MAX_CHANGE_BATCH_BYTES}`,
    );
  }

  const sourceIds = changes.map((change) => change.version.sourceId);
  const sourceId = commonValue(sourceIds) ?? "mixed";
  const sourceEpoch = commonValue(
    changes.map((change) => change.version.sourceEpoch),
  );
  const sourceCursor = commonValue(
    changes.map((change) => change.version.sourceCursor),
  );
  const transactionId = crypto.randomUUID();
  const now = Date.now();

  return [
    db
      .prepare(
        `UPDATE change_log_state
         SET head_position = head_position + 1
         WHERE id = 1`,
      ),
    db
      .prepare(
        `INSERT INTO change_batches
         (generation_id, position, projection_transaction_id, source_id,
          source_epoch, source_cursor, phase, changes_json, change_count,
          encoded_bytes, created_at)
         VALUES (
           (SELECT generation_id FROM change_log_state WHERE id = 1),
           (SELECT head_position FROM change_log_state WHERE id = 1),
           ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .bind(
        transactionId,
        sourceId,
        sourceEpoch,
        sourceCursor,
        phase,
        serialized,
        changes.length,
        bytes,
        now,
      ),
  ];
}
