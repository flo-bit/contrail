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

/** Initialize one immutable milestone-1 logging definition. Later milestones
 * add explicit quiet-boundary operations for changing this durable definition. */
export async function initializeChangeLog(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  if (!changesEnabled(config)) return;

  const definitions = canonicalChangeDefinitions(config);
  const now = Date.now();
  const candidateGeneration = crypto.randomUUID();
  const statements: Statement[] = [
    db
      .prepare(
        `INSERT INTO change_log_state
         (id, generation_id, head_position, retained_floor_position,
          definitions_json, created_at)
         VALUES (1, ?, 0, 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(candidateGeneration, definitions, now),
  ];

  for (const [consumerId, consumer] of Object.entries(
    config.changes?.consumers ?? {},
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const initialReady = consumer.initial === "current" ? "pending" : "ready";
    statements.push(
      db
        .prepare(
          `INSERT INTO change_consumers
           (consumer_id, generation_id, acknowledged_position,
            configured_collections_json, configured_phases_json, initial_mode,
            required_for_activation, bootstrap_state,
            bootstrap_anchor_position, attempts, updated_at)
           SELECT ?, generation_id, 0, ?, ?, ?, ?, ?,
                  CASE WHEN ? = 'current' THEN 0 ELSE NULL END,
                  0, ?
           FROM change_log_state
           WHERE id = 1 AND definitions_json = ?
           ON CONFLICT(consumer_id) DO NOTHING`,
        )
        .bind(
          consumerId,
          canonicalCollections(consumer.collections),
          canonicalPhases(changeConsumerPhases(consumer)),
          consumer.initial,
          consumer.requiredForActivation === true ? 1 : 0,
          initialReady,
          consumer.initial,
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

  // Keep initialization under conservative D1 statement limits. The durable
  // definitions_json winner makes these resumable chunks safe under concurrent
  // initialization; init does not return until the complete set verifies.
  await db.batch(statements.slice(0, 1));
  for (let index = 1; index < statements.length; index += 50) {
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
  const expectedConsumers = Object.entries(config.changes?.consumers ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (consumers.results.length !== expectedConsumers.length) {
    throw new Error("Durable change consumer registration is incomplete");
  }
  for (let index = 0; index < expectedConsumers.length; index++) {
    const [id, expected] = expectedConsumers[index]!;
    const actual = consumers.results[index]!;
    if (
      actual.consumer_id !== id ||
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
  for (let index = 0; index < expectedCoverage.length; index++) {
    const actual = coverage.results[index]!;
    const expected = expectedCoverage[index]!;
    if (
      actual.generation_id !== state.generation_id ||
      actual.collection !== expected.collection ||
      actual.phase !== expected.phase ||
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
