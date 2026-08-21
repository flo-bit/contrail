import type {
  ContrailConfig,
  Database,
  ProjectionPhase,
} from "./types";
import {
  changeConsumerPhases,
  recordsTableName,
  resolveCollectionKey,
} from "./types";
import {
  getChangeLogState,
  type ChangeLogState,
  type RecordChange,
} from "./change-log";
import {
  acknowledgeCurrentSnapshotPage,
  claimCurrentActivation,
  claimCurrentSnapshotPage,
  completeCurrentActivation,
  failCurrentActivation,
  failCurrentSnapshotPage,
  getCurrentBootstrapStatus,
  renewCurrentBootstrapClaim,
  type CurrentActivationClaim,
  type CurrentBootstrapClaimOptions,
  type CurrentBootstrapStatus,
  type CurrentSnapshotClaim,
} from "./change-bootstrap";

const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_MAX_CHANGES = 500;
const DEFAULT_MAX_BYTES = 512_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_AUTO_ADVANCE_RANGES = 8;
const MAX_CLAIM_BATCHES = 100;
const MAX_CLAIM_CHANGES = 5_000;
const MAX_CLAIM_BYTES = 4 * 1_024 * 1_024;
const MAX_LEASE_MS = 10 * 60_000;
const FAILURE_CODE = /^[a-zA-Z0-9_.:-]{1,64}$/;

export class ChangeConsumerNotFoundError extends Error {}
export class ChangeClaimTooLargeError extends Error {}
export class ChangeLeaseLostError extends Error {}
export class ChangeHistoryGapError extends Error {}
export class ChangeGenerationMismatchError extends Error {}

export interface ChangeClaimOptions {
  maxBatches?: number;
  maxChanges?: number;
  maxBytes?: number;
  leaseMs?: number;
  /** Maximum irrelevant position ranges core may acknowledge without invoking
   * a handler in one claim call. */
  maxAutoAdvanceRanges?: number;
  /** @internal Deterministic clock seam for conformance tests. */
  now?: number;
}

export interface ChangeClaim {
  consumerId: string;
  generation: string;
  from: string;
  through: string;
  changes: RecordChange[];
  attempt: number;
  leaseExpiresAt: number;
  /** Generation-scoped destination token during current-state catch-up. */
  readonly bootstrapToken?: string;
  /** Fixed catch-up target for a current-state bootstrap claim. */
  readonly bootstrapTarget?: string;
  /** Opaque CAS capability. Do not pass this field to delivery handlers. */
  readonly leaseOwner: string;
}

export interface CurrentRecord {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string | null;
  value: unknown;
  timeUs: number;
  indexedAt: number;
}

export interface DeliveryBatch {
  consumerId: string;
  cursor: {
    generation: string;
    from: string;
    through: string;
  };
  changes: RecordChange[];
  currentRecords: CurrentRecord[];
  absentUris: string[];
  /** Generation-scoped destination token during current bootstrap catch-up. */
  destinationToken?: string;
}

export interface ChangeFailure {
  /** Stable sanitized category. Raw destination errors are never persisted. */
  code: string;
  /** Runtime-computed retry eligibility. Null makes the claim immediately due. */
  nextAttemptAt: number | null;
}

export interface ChangeConsumerStatus {
  id: string;
  generation: string;
  position: string;
  bootstrapState: string;
  initialMode: string;
  requiredForActivation: boolean;
  attempts: number;
  nextAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  leased: boolean;
  leaseExpiresAt: number | null;
  backlogBatches: number;
  backlogChanges: number;
  backlogBytes: number;
  oldestPendingAt: number | null;
  generationMatches: boolean;
}

export interface ChangeLogStatus {
  enabled: boolean;
  state: ChangeLogState | null;
  rows: number;
  changes: number;
  bytes: number;
  oldestRetainedAt: number | null;
  consumers: ChangeConsumerStatus[];
}

interface DurableConsumerRow {
  consumer_id: string;
  generation_id: string;
  acknowledged_position: number | string;
  configured_collections_json: string;
  configured_phases_json: string;
  initial_mode: string;
  required_for_activation: number | string;
  bootstrap_state: string;
  bootstrap_target_position: number | string | null;
  bootstrap_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | string | null;
  attempts: number | string;
  next_attempt_at: number | string | null;
  last_success_at: number | string | null;
  last_error_code: string | null;
  last_error_at: number | string | null;
}

interface BatchMetadataRow {
  position: number | string;
  phase: ProjectionPhase;
  change_count: number | string;
  encoded_bytes: number | string;
}

interface StoredBatchRow extends BatchMetadataRow {
  changes_json: string;
}

interface BacklogRow {
  backlog_batches: number | string;
  backlog_changes: number | string | null;
  backlog_bytes: number | string | null;
  oldest_pending_at: number | string | null;
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function timestamp(value: number | undefined = Date.now()): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now must be a non-negative safe integer");
  }
  return value;
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function parseStringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string") ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`${label} is malformed`);
  }
  return parsed;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeChange(
  value: unknown,
  generation: string,
  position: string,
  ordinal: number,
): RecordChange {
  if (
    !object(value) ||
    value.kind !== "record" ||
    (value.operation !== "put" && value.operation !== "delete") ||
    typeof value.uri !== "string" ||
    typeof value.did !== "string" ||
    typeof value.collection !== "string" ||
    typeof value.rkey !== "string" ||
    (value.cid !== null && typeof value.cid !== "string") ||
    !object(value.version) ||
    typeof value.version.sourceId !== "string" ||
    (value.version.sourceEpoch !== null &&
      typeof value.version.sourceEpoch !== "string") ||
    (value.version.sourceRevision !== null &&
      typeof value.version.sourceRevision !== "string") ||
    !Number.isSafeInteger(value.version.sourceTimeUs) ||
    Number(value.version.sourceTimeUs) < 0 ||
    (value.version.sourceCursor !== null &&
      typeof value.version.sourceCursor !== "string")
  ) {
    throw new Error(`Change batch ${generation}/${position} is malformed`);
  }
  return {
    ...(value as unknown as Omit<RecordChange, "id">),
    id: `${generation}:${position}:${ordinal}`,
  };
}

function decodeBatchChanges(
  row: StoredBatchRow,
  generation: string,
): RecordChange[] {
  const position = String(row.position);
  const encoded = new TextEncoder().encode(row.changes_json).byteLength;
  if (encoded !== Number(row.encoded_bytes)) {
    throw new Error(`Change batch ${generation}/${position} byte count is invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.changes_json);
  } catch {
    throw new Error(`Change batch ${generation}/${position} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== Number(row.change_count)) {
    throw new Error(`Change batch ${generation}/${position} count is invalid`);
  }
  return parsed.map((change, ordinal) =>
    decodeChange(change, generation, position, ordinal),
  );
}

async function durableConsumer(
  db: Database,
  consumerId: string,
): Promise<DurableConsumerRow | null> {
  return db
    .prepare(
      `SELECT consumer_id, generation_id, acknowledged_position,
              configured_collections_json, configured_phases_json,
              initial_mode, required_for_activation, bootstrap_state,
              bootstrap_target_position, bootstrap_token,
              lease_owner, lease_expires_at, attempts, next_attempt_at,
              last_success_at, last_error_code, last_error_at
       FROM change_consumers WHERE consumer_id = ?`,
    )
    .bind(consumerId)
    .first<DurableConsumerRow>();
}

async function releaseLease(
  db: Database,
  consumerId: string,
  generation: string,
  from: string,
  owner: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE change_consumers
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND acknowledged_position = ? AND lease_owner = ?`,
    )
    .bind(now, consumerId, generation, from, owner)
    .run();
}

function normalizedClaimOptions(options: ChangeClaimOptions = {}) {
  return {
    maxBatches: integer(
      options.maxBatches,
      DEFAULT_MAX_BATCHES,
      1,
      MAX_CLAIM_BATCHES,
      "maxBatches",
    ),
    maxChanges: integer(
      options.maxChanges,
      DEFAULT_MAX_CHANGES,
      1,
      MAX_CLAIM_CHANGES,
      "maxChanges",
    ),
    maxBytes: integer(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      1,
      MAX_CLAIM_BYTES,
      "maxBytes",
    ),
    leaseMs: integer(
      options.leaseMs,
      DEFAULT_LEASE_MS,
      1,
      MAX_LEASE_MS,
      "leaseMs",
    ),
    maxAutoAdvanceRanges: integer(
      options.maxAutoAdvanceRanges,
      DEFAULT_AUTO_ADVANCE_RANGES,
      0,
      32,
      "maxAutoAdvanceRanges",
    ),
    now: timestamp(options.now),
  };
}

/** Verify that schema initialization registered one configured consumer. */
export async function registerChangeConsumer(
  db: Database,
  config: ContrailConfig,
  consumerId: string,
): Promise<void> {
  const configured = config.changes?.consumers[consumerId];
  if (!configured) {
    throw new ChangeConsumerNotFoundError(
      `Change consumer ${consumerId} is not configured`,
    );
  }
  const state = await getChangeLogState(db);
  if (!state) {
    throw new ChangeConsumerNotFoundError(
      `Change consumer ${consumerId} is not initialized`,
    );
  }
  const durable = await durableConsumer(db, consumerId);
  if (!durable) {
    throw new ChangeConsumerNotFoundError(
      `Change consumer ${consumerId} is not initialized`,
    );
  }
  const collections = parseStringArray(
    durable.configured_collections_json,
    `Change consumer ${consumerId} collections`,
  );
  const phases = parseStringArray(
    durable.configured_phases_json,
    `Change consumer ${consumerId} phases`,
  );
  if (
    durable.generation_id !== state.generation ||
    JSON.stringify(collections) !==
      JSON.stringify([...configured.collections].sort()) ||
    JSON.stringify(phases) !==
      JSON.stringify([...changeConsumerPhases(configured)].sort()) ||
    durable.initial_mode !== configured.initial ||
    Number(durable.required_for_activation) !==
      (configured.requiredForActivation === true ? 1 : 0)
  ) {
    throw new Error(`Change consumer ${consumerId} is incompatible`);
  }
}

/** Claim one bounded contiguous position range. Irrelevant ranges advance by
 * CAS without invoking application code. */
async function claimChangeRange(
  db: Database,
  consumerId: string,
  options: ChangeClaimOptions = {},
  bootstrap = false,
): Promise<ChangeClaim | null> {
  const limits = normalizedClaimOptions(options);
  const requiredState = bootstrap ? "catching-up" : "ready";
  if (!(await getChangeLogState(db))) {
    throw new ChangeConsumerNotFoundError(
      `Change consumer ${consumerId} is not initialized`,
    );
  }

  for (
    let autoAdvanced = 0;
    autoAdvanced <= limits.maxAutoAdvanceRanges;
    autoAdvanced++
  ) {
    const owner = crypto.randomUUID();
    const leaseExpiresAt = limits.now + limits.leaseMs;
    const leased = await db
      .prepare(
        `UPDATE change_consumers
         SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE consumer_id = ?
           AND bootstrap_state = '${requiredState}'
           AND generation_id = (SELECT generation_id FROM change_log_state WHERE id = 1)
           AND acknowledged_position >= (SELECT retained_floor_position FROM change_log_state WHERE id = 1)
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (lease_owner IS NULL OR lease_expires_at <= ?)
         RETURNING consumer_id, generation_id, acknowledged_position,
                   configured_collections_json, configured_phases_json,
                   initial_mode, required_for_activation, bootstrap_state,
                   bootstrap_target_position, bootstrap_token,
                   lease_owner, lease_expires_at, attempts, next_attempt_at,
                   last_success_at, last_error_code, last_error_at`,
      )
      .bind(
        owner,
        leaseExpiresAt,
        limits.now,
        consumerId,
        limits.now,
        limits.now,
      )
      .first<DurableConsumerRow>();
    if (!leased) {
      const durable = await durableConsumer(db, consumerId);
      if (!durable) {
        throw new ChangeConsumerNotFoundError(
          `Change consumer ${consumerId} is not initialized`,
        );
      }
      const state = await getChangeLogState(db);
      if (state && durable.generation_id !== state.generation) {
        throw new ChangeGenerationMismatchError(
          `Change consumer ${consumerId} belongs to generation ${durable.generation_id}, not ${state.generation}`,
        );
      }
      if (
        state &&
        BigInt(String(durable.acknowledged_position)) <
          BigInt(state.retainedFloor)
      ) {
        throw new ChangeHistoryGapError(
          `Change consumer ${consumerId} is behind retained floor ${state.retainedFloor}`,
        );
      }
      return null;
    }

    const generation = leased.generation_id;
    const from = String(leased.acknowledged_position);
    const bootstrapTarget = bootstrap
      ? String(leased.bootstrap_target_position)
      : null;
    if (bootstrap && leased.bootstrap_target_position === null) {
      await releaseLease(db, consumerId, generation, from, owner, limits.now);
      throw new Error(`Change consumer ${consumerId} has no bootstrap target`);
    }
    const metadata = await db
      .prepare(
        `SELECT position, phase, change_count, encoded_bytes
         FROM change_batches
         WHERE generation_id = ? AND position > ?
           AND (? IS NULL OR position <= ?)
         ORDER BY position
         LIMIT ?`,
      )
      .bind(
        generation,
        from,
        bootstrapTarget,
        bootstrapTarget,
        limits.maxBatches,
      )
      .all<BatchMetadataRow>();

    if (metadata.results.length === 0) {
      if (bootstrap && from === bootstrapTarget) {
        await db
          .prepare(
            `UPDATE change_consumers
             SET bootstrap_state = 'activating', lease_owner = NULL,
                 lease_expires_at = NULL, updated_at = ?
             WHERE consumer_id = ? AND generation_id = ?
               AND bootstrap_state = 'catching-up'
               AND acknowledged_position = bootstrap_target_position
               AND acknowledged_position = ? AND lease_owner = ?`,
          )
          .bind(limits.now, consumerId, generation, from, owner)
          .run();
        return null;
      }
      const state = await getChangeLogState(db);
      await releaseLease(db, consumerId, generation, from, owner, limits.now);
      const expectedHead = bootstrap ? bootstrapTarget : state?.head;
      if (
        expectedHead !== null &&
        expectedHead !== undefined &&
        expectedHead !== from
      ) {
        throw new ChangeHistoryGapError(
          `Change consumer ${consumerId} cannot resume from ${from}; target is ${expectedHead}`,
        );
      }
      return null;
    }

    const expectedFirst = BigInt(from) + 1n;
    if (BigInt(String(metadata.results[0]!.position)) !== expectedFirst) {
      await releaseLease(db, consumerId, generation, from, owner, limits.now);
      throw new ChangeHistoryGapError(
        `Change consumer ${consumerId} has a gap after ${from}`,
      );
    }

    for (let index = 0; index < metadata.results.length; index++) {
      const expected = BigInt(from) + BigInt(index) + 1n;
      if (BigInt(String(metadata.results[index]!.position)) !== expected) {
        await releaseLease(db, consumerId, generation, from, owner, limits.now);
        throw new ChangeHistoryGapError(
          `Change consumer ${consumerId} has a gap after ${from}`,
        );
      }
    }

    const selected: BatchMetadataRow[] = [];
    let totalChanges = 0;
    let totalBytes = 0;
    for (const row of metadata.results) {
      const count = Number(row.change_count);
      const bytes = Number(row.encoded_bytes);
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1
      ) {
        await releaseLease(db, consumerId, generation, from, owner, limits.now);
        throw new Error(`Change batch ${generation}/${row.position} has invalid bounds`);
      }
      if (
        selected.length > 0 &&
        (totalChanges + count > limits.maxChanges ||
          totalBytes + bytes > limits.maxBytes)
      ) {
        break;
      }
      if (count > limits.maxChanges || bytes > limits.maxBytes) {
        await releaseLease(db, consumerId, generation, from, owner, limits.now);
        throw new ChangeClaimTooLargeError(
          `Change batch ${generation}/${row.position} exceeds this consumer's claim limits`,
        );
      }
      selected.push(row);
      totalChanges += count;
      totalBytes += bytes;
    }

    const through = String(selected.at(-1)!.position);
    const rows = await db
      .prepare(
        `SELECT position, phase, change_count, encoded_bytes, changes_json
         FROM change_batches
         WHERE generation_id = ? AND position > ? AND position <= ?
         ORDER BY position`,
      )
      .bind(generation, from, through)
      .all<StoredBatchRow>();
    if (rows.results.length !== selected.length) {
      await releaseLease(db, consumerId, generation, from, owner, limits.now);
      throw new ChangeHistoryGapError(
        `Change consumer ${consumerId} lost claimed history`,
      );
    }

    const collections = new Set(
      parseStringArray(
        leased.configured_collections_json,
        `Change consumer ${consumerId} collections`,
      ),
    );
    const phases = new Set(
      parseStringArray(
        leased.configured_phases_json,
        `Change consumer ${consumerId} phases`,
      ),
    );
    const coalesced = new Map<string, RecordChange>();
    for (const row of rows.results) {
      if (!phases.has(row.phase)) continue;
      for (const change of decodeBatchChanges(row, generation)) {
        if (!collections.has(change.collection)) continue;
        coalesced.delete(change.uri);
        coalesced.set(change.uri, change);
      }
    }

    const claim: ChangeClaim = {
      consumerId,
      generation,
      from,
      through,
      changes: [...coalesced.values()],
      attempt: Number(leased.attempts) + 1,
      leaseExpiresAt,
      ...(leased.bootstrap_token === null
        ? {}
        : { bootstrapToken: leased.bootstrap_token }),
      ...(bootstrapTarget === null ? {} : { bootstrapTarget }),
      leaseOwner: owner,
    };
    if (claim.changes.length > 0) return claim;

    await acknowledgeChanges(db, claim, { now: limits.now });
    if (autoAdvanced === limits.maxAutoAdvanceRanges) return null;
  }
  return null;
}

export function claimChanges(
  db: Database,
  consumerId: string,
  options: ChangeClaimOptions = {},
): Promise<ChangeClaim | null> {
  return claimChangeRange(db, consumerId, options, false);
}

/** Claim changes only through the fixed target of a current-state bootstrap. */
export function claimCurrentBootstrapChanges(
  db: Database,
  consumerId: string,
  options: ChangeClaimOptions = {},
): Promise<ChangeClaim | null> {
  return claimChangeRange(db, consumerId, options, true);
}

/** Hydrate the newest canonical state for each coalesced claimed URI. */
export async function hydrateChanges(
  db: Database,
  config: ContrailConfig,
  claim: ChangeClaim,
): Promise<DeliveryBatch> {
  const byCollection = new Map<string, string[]>();
  for (const change of claim.changes) {
    const uris = byCollection.get(change.collection) ?? [];
    uris.push(change.uri);
    byCollection.set(change.collection, uris);
  }

  const found = new Map<string, CurrentRecord>();
  for (const [collection, uris] of byCollection) {
    const short = resolveCollectionKey(config, collection);
    if (!short) {
      throw new Error(`Claim references unconfigured collection ${collection}`);
    }
    const table = recordsTableName(short);
    for (let index = 0; index < uris.length; index += 50) {
      const chunk = uris.slice(index, index + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(
          `SELECT uri, did, rkey, cid, record, time_us, indexed_at
           FROM ${table} WHERE uri IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{
          uri: string;
          did: string;
          rkey: string;
          cid: string | null;
          record: string;
          time_us: number | string;
          indexed_at: number | string;
        }>();
      for (const row of rows.results) {
        let value: unknown;
        try {
          value = JSON.parse(row.record);
        } catch {
          throw new Error(`Current record ${row.uri} is not valid JSON`);
        }
        found.set(row.uri, {
          uri: row.uri,
          did: row.did,
          collection,
          rkey: row.rkey,
          cid: row.cid,
          value,
          timeUs: Number(row.time_us),
          indexedAt: Number(row.indexed_at),
        });
      }
    }
  }

  const currentRecords: CurrentRecord[] = [];
  const absentUris: string[] = [];
  for (const change of claim.changes) {
    const current = found.get(change.uri);
    if (current) currentRecords.push(current);
    else absentUris.push(change.uri);
  }
  return {
    consumerId: claim.consumerId,
    cursor: {
      generation: claim.generation,
      from: claim.from,
      through: claim.through,
    },
    changes: claim.changes,
    currentRecords,
    absentUris,
    ...(claim.bootstrapToken
      ? { destinationToken: claim.bootstrapToken }
      : {}),
  };
}

export async function acknowledgeChanges(
  db: Database,
  claim: ChangeClaim,
  options: { now?: number } = {},
): Promise<void> {
  const now = timestamp(options.now);
  const acknowledged = await db
    .prepare(
      `UPDATE change_consumers
       SET acknowledged_position = ?,
           bootstrap_state = CASE
             WHEN bootstrap_state = 'catching-up'
              AND ? = bootstrap_target_position THEN 'activating'
             ELSE bootstrap_state END,
           lease_owner = NULL, lease_expires_at = NULL,
           attempts = 0, next_attempt_at = NULL,
           last_success_at = ?, last_error_code = NULL, last_error_at = NULL,
           updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND acknowledged_position = ? AND lease_owner = ?
         AND lease_expires_at > ?
         AND ? > acknowledged_position
         AND ? <= (
           SELECT head_position FROM change_log_state
           WHERE id = 1 AND generation_id = ?
         )
       RETURNING consumer_id`,
    )
    .bind(
      claim.through,
      claim.through,
      now,
      now,
      claim.consumerId,
      claim.generation,
      claim.from,
      claim.leaseOwner,
      now,
      claim.through,
      claim.through,
      claim.generation,
    )
    .first<{ consumer_id: string }>();
  if (!acknowledged) {
    throw new ChangeLeaseLostError(
      `Change claim for ${claim.consumerId} is stale or expired`,
    );
  }
}

export async function renewChangeClaim(
  db: Database,
  claim: ChangeClaim,
  options: { leaseMs?: number; now?: number } = {},
): Promise<ChangeClaim> {
  const now = timestamp(options.now);
  const leaseMs = integer(
    options.leaseMs,
    DEFAULT_LEASE_MS,
    1,
    MAX_LEASE_MS,
    "leaseMs",
  );
  const expires = now + leaseMs;
  const renewed = await db
    .prepare(
      `UPDATE change_consumers
       SET lease_expires_at = ?, updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND acknowledged_position = ? AND lease_owner = ?
         AND lease_expires_at > ?
       RETURNING consumer_id`,
    )
    .bind(
      expires,
      now,
      claim.consumerId,
      claim.generation,
      claim.from,
      claim.leaseOwner,
      now,
    )
    .first<{ consumer_id: string }>();
  if (!renewed) {
    throw new ChangeLeaseLostError(
      `Change claim for ${claim.consumerId} cannot be renewed`,
    );
  }
  return { ...claim, leaseExpiresAt: expires };
}

export async function failChanges(
  db: Database,
  claim: ChangeClaim,
  failure: ChangeFailure,
  options: { now?: number } = {},
): Promise<{ attempts: number; nextAttemptAt: number | null }> {
  const now = timestamp(options.now);
  if (!FAILURE_CODE.test(failure.code)) {
    throw new TypeError(
      "Change failure code must contain 1-64 safe identifier characters",
    );
  }
  if (
    failure.nextAttemptAt !== null &&
    (!Number.isSafeInteger(failure.nextAttemptAt) ||
      failure.nextAttemptAt < now)
  ) {
    throw new TypeError("nextAttemptAt must be null or a future safe timestamp");
  }
  const failed = await db
    .prepare(
      `UPDATE change_consumers
       SET lease_owner = NULL, lease_expires_at = NULL,
           attempts = attempts + 1, next_attempt_at = ?,
           last_error_code = ?, last_error_at = ?, updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND acknowledged_position = ? AND lease_owner = ?
         AND lease_expires_at > ?
       RETURNING attempts, next_attempt_at`,
    )
    .bind(
      failure.nextAttemptAt,
      failure.code,
      now,
      now,
      claim.consumerId,
      claim.generation,
      claim.from,
      claim.leaseOwner,
      now,
    )
    .first<{ attempts: number | string; next_attempt_at: number | string | null }>();
  if (!failed) {
    throw new ChangeLeaseLostError(
      `Change claim for ${claim.consumerId} is stale or expired`,
    );
  }
  return {
    attempts: Number(failed.attempts),
    nextAttemptAt: nullableNumber(failed.next_attempt_at),
  };
}

export async function retryChangeConsumer(
  db: Database,
  consumerId: string,
  options: { now?: number } = {},
): Promise<void> {
  const now = timestamp(options.now);
  if (!(await getChangeLogState(db))) {
    throw new ChangeConsumerNotFoundError(
      `Change consumer ${consumerId} is not initialized`,
    );
  }
  const retried = await db
    .prepare(
      `UPDATE change_consumers
       SET next_attempt_at = NULL, last_error_code = NULL,
           last_error_at = NULL, updated_at = ?
       WHERE consumer_id = ?
         AND generation_id = (SELECT generation_id FROM change_log_state WHERE id = 1)
         AND (lease_owner IS NULL OR lease_expires_at <= ?)
       RETURNING consumer_id`,
    )
    .bind(now, consumerId, now)
    .first<{ consumer_id: string }>();
  if (!retried) {
    const existing = await durableConsumer(db, consumerId);
    if (!existing) {
      throw new ChangeConsumerNotFoundError(
        `Change consumer ${consumerId} is not initialized`,
      );
    }
    throw new ChangeLeaseLostError(
      `Change consumer ${consumerId} currently has an active lease`,
    );
  }
}

export async function getChangesStatus(db: Database): Promise<ChangeLogStatus> {
  const state = await getChangeLogState(db);
  if (!state) {
    return {
      enabled: false,
      state: null,
      rows: 0,
      changes: 0,
      bytes: 0,
      oldestRetainedAt: null,
      consumers: [],
    };
  }
  const aggregate = await db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(change_count), 0) AS changes,
              COALESCE(SUM(encoded_bytes), 0) AS bytes,
              MIN(created_at) AS oldest_retained_at
       FROM change_batches WHERE generation_id = ?`,
    )
    .bind(state.generation)
    .first<{
      rows: number | string;
      changes: number | string;
      bytes: number | string;
      oldest_retained_at: number | string | null;
    }>();
  const rows = await db
    .prepare(
      `SELECT consumer_id, generation_id, acknowledged_position,
              configured_collections_json, configured_phases_json,
              initial_mode, required_for_activation, bootstrap_state,
              bootstrap_target_position, bootstrap_token,
              lease_owner, lease_expires_at, attempts, next_attempt_at,
              last_success_at, last_error_code, last_error_at
       FROM change_consumers ORDER BY consumer_id`,
    )
    .all<DurableConsumerRow>();
  const consumers: ChangeConsumerStatus[] = [];
  for (const row of rows.results) {
    const backlog = await db
      .prepare(
        `SELECT COUNT(*) AS backlog_batches,
                COALESCE(SUM(change_count), 0) AS backlog_changes,
                COALESCE(SUM(encoded_bytes), 0) AS backlog_bytes,
                MIN(created_at) AS oldest_pending_at
         FROM change_batches
         WHERE generation_id = ? AND position > ?`,
      )
      .bind(row.generation_id, row.acknowledged_position)
      .first<BacklogRow>();
    const generationMatches = row.generation_id === state.generation;
    consumers.push({
      id: row.consumer_id,
      generation: row.generation_id,
      position: String(row.acknowledged_position),
      bootstrapState: generationMatches ? row.bootstrap_state : "reset-required",
      initialMode: row.initial_mode,
      requiredForActivation: Number(row.required_for_activation) === 1,
      attempts: Number(row.attempts),
      nextAttemptAt: nullableNumber(row.next_attempt_at),
      lastSuccessAt: nullableNumber(row.last_success_at),
      lastErrorCode: row.last_error_code,
      lastErrorAt: nullableNumber(row.last_error_at),
      leased: row.lease_owner !== null,
      leaseExpiresAt: nullableNumber(row.lease_expires_at),
      backlogBatches: Number(backlog?.backlog_batches ?? 0),
      backlogChanges: Number(backlog?.backlog_changes ?? 0),
      backlogBytes: Number(backlog?.backlog_bytes ?? 0),
      oldestPendingAt: nullableNumber(backlog?.oldest_pending_at ?? null),
      generationMatches,
    });
  }
  return {
    enabled: true,
    state,
    rows: Number(aggregate?.rows ?? 0),
    changes: Number(aggregate?.changes ?? 0),
    bytes: Number(aggregate?.bytes ?? 0),
    oldestRetainedAt: nullableNumber(aggregate?.oldest_retained_at ?? null),
    consumers,
  };
}

export interface RequiredChangeConsumerReadiness {
  ready: boolean;
  through: string;
  pending: Array<{
    id: string;
    state: string;
    position: string;
  }>;
}

/** Check activation-gating consumers against one fixed log target. */
export async function getRequiredChangeConsumerReadiness(
  db: Database,
  through?: string,
): Promise<RequiredChangeConsumerReadiness> {
  const state = await getChangeLogState(db);
  if (!state) return { ready: true, through: "0", pending: [] };
  const target = through ?? state.head;
  if (!/^\d+$/.test(target) || BigInt(target) > BigInt(state.head)) {
    throw new TypeError("Required-consumer target must be a retained log position at or below head");
  }
  const rows = await db
    .prepare(
      `SELECT consumer_id, bootstrap_state, acknowledged_position
       FROM change_consumers
       WHERE generation_id = ? AND required_for_activation = 1
       ORDER BY consumer_id`,
    )
    .bind(state.generation)
    .all<{
      consumer_id: string;
      bootstrap_state: string;
      acknowledged_position: number | string;
    }>();
  const pending = rows.results
    .filter(
      (row) =>
        row.bootstrap_state !== "ready" ||
        BigInt(String(row.acknowledged_position)) < BigInt(target),
    )
    .map((row) => ({
      id: row.consumer_id,
      state: row.bootstrap_state,
      position: String(row.acknowledged_position),
    }));
  return { ready: pending.length === 0, through: target, pending };
}

export async function assertRequiredChangeConsumersReady(
  db: Database,
  through?: string,
): Promise<void> {
  const readiness = await getRequiredChangeConsumerReadiness(db, through);
  if (!readiness.ready) {
    throw new Error(
      `Required change consumers are not ready through ${readiness.through}: ` +
        readiness.pending.map((item) => item.id).join(", "),
    );
  }
}

export interface SkipChangeConsumerOptions {
  through: string;
  reason: string;
  confirm: boolean;
  /** @internal Deterministic clock seam for conformance tests. */
  now?: number;
}

/** Explicit audited data-loss operation for one ready consumer. */
export async function skipChangeConsumer(
  db: Database,
  consumerId: string,
  options: SkipChangeConsumerOptions,
): Promise<void> {
  if (options.confirm !== true) {
    throw new Error("Skipping change delivery requires confirm: true");
  }
  const reason = options.reason.trim();
  if (reason.length === 0 || reason.length > 256) {
    throw new TypeError("Skip reason must contain 1-256 characters");
  }
  if (!/^\d+$/.test(options.through)) {
    throw new TypeError("Skip position must be an opaque decimal string");
  }
  const timestampValue = timestamp(options.now);
  const state = await getChangeLogState(db);
  const consumer = state ? await durableConsumer(db, consumerId) : null;
  if (!state || !consumer) {
    throw new ChangeConsumerNotFoundError(
      `Change consumer ${consumerId} is not initialized`,
    );
  }
  const from = String(consumer.acknowledged_position);
  if (
    consumer.generation_id !== state.generation ||
    consumer.bootstrap_state !== "ready" ||
    BigInt(options.through) <= BigInt(from) ||
    BigInt(options.through) > BigInt(state.head)
  ) {
    throw new Error("Skip position is outside this ready consumer's pending range");
  }
  const actionId = crypto.randomUUID();
  const actionMarker = `operator_skip:${actionId}`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE change_consumers
         SET acknowledged_position = ?, lease_owner = NULL,
             lease_expires_at = NULL, attempts = 0, next_attempt_at = NULL,
             last_error_code = ?, last_error_at = ?, updated_at = ?
         WHERE consumer_id = ? AND generation_id = ?
           AND acknowledged_position = ?
           AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      )
      .bind(
        options.through,
        actionMarker,
        timestampValue,
        timestampValue,
        consumerId,
        state.generation,
        from,
        timestampValue,
      ),
    db
      .prepare(
        `INSERT INTO change_consumer_actions
         (action_id, generation_id, consumer_id, action, from_position,
          through_position, reason, created_at)
         SELECT ?, generation_id, consumer_id, 'skip', ?,
                acknowledged_position, ?, ?
         FROM change_consumers
         WHERE consumer_id = ? AND generation_id = ?
           AND acknowledged_position = ? AND last_error_code = ?`,
      )
      .bind(
        actionId,
        from,
        reason,
        timestampValue,
        consumerId,
        state.generation,
        options.through,
        actionMarker,
      ),
  ]);
  if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1) {
    throw new ChangeLeaseLostError(
      `Change consumer ${consumerId} changed during skip`,
    );
  }
}

export interface PruneChangesOptions {
  maxBatches?: number;
  /** Delete only batches older than this timestamp. */
  olderThan?: number;
}

export interface PruneChangesResult {
  pruned: number;
  retainedFloor: string;
  safeThrough: string;
  done: boolean;
}

function affectedRows(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const value = result as {
    changes?: unknown;
    rowsAffected?: unknown;
    meta?: { changes?: unknown };
  };
  return Number(value.changes ?? value.rowsAffected ?? value.meta?.changes ?? 0);
}

/** Consumer-aware bounded pruning. The slowest durable position, including a
 * current bootstrap anchor, is the hard safety boundary. */
export async function pruneChanges(
  db: Database,
  options: PruneChangesOptions = {},
): Promise<PruneChangesResult> {
  const maxBatches = integer(
    options.maxBatches,
    500,
    1,
    5_000,
    "maxBatches",
  );
  if (
    options.olderThan !== undefined &&
    (!Number.isSafeInteger(options.olderThan) || options.olderThan < 0)
  ) {
    throw new TypeError("olderThan must be a non-negative safe timestamp");
  }
  const state = await getChangeLogState(db);
  if (!state) {
    return {
      pruned: 0,
      retainedFloor: "0",
      safeThrough: "0",
      done: true,
    };
  }
  const slowest = await db
    .prepare(
      `SELECT MIN(acknowledged_position) AS safe_through
       FROM change_consumers WHERE generation_id = ?`,
    )
    .bind(state.generation)
    .first<{ safe_through: number | string | null }>();
  const safeThrough = String(slowest?.safe_through ?? state.retainedFloor);
  if (BigInt(safeThrough) <= BigInt(state.retainedFloor)) {
    return {
      pruned: 0,
      retainedFloor: state.retainedFloor,
      safeThrough,
      done: true,
    };
  }

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM change_batches
         WHERE generation_id = ? AND position IN (
           SELECT position FROM change_batches
           WHERE generation_id = ? AND position > ? AND position <= ?
             AND (? IS NULL OR created_at < ?)
           ORDER BY position LIMIT ?
         )`,
      )
      .bind(
        state.generation,
        state.generation,
        state.retainedFloor,
        safeThrough,
        options.olderThan ?? null,
        options.olderThan ?? null,
        maxBatches,
      ),
    db
      .prepare(
        `UPDATE change_log_state
         SET retained_floor_position = CASE
           WHEN EXISTS (
             SELECT 1 FROM change_batches WHERE generation_id = ?
           ) THEN (
             SELECT MIN(position) - 1 FROM change_batches
             WHERE generation_id = ?
           )
           ELSE head_position END
         WHERE id = 1 AND generation_id = ?`,
      )
      .bind(state.generation, state.generation, state.generation),
  ]);
  const updated = await getChangeLogState(db);
  if (!updated || updated.generation !== state.generation) {
    throw new ChangeGenerationMismatchError(
      "Change-log generation changed during pruning",
    );
  }
  const pruned = affectedRows(results[0]);
  return {
    pruned,
    retainedFloor: updated.retainedFloor,
    safeThrough,
    done:
      pruned < maxBatches ||
      BigInt(updated.retainedFloor) >= BigInt(safeThrough),
  };
}

type DatabaseResolver = (db?: Database) => Database;

/** Bound low-level API exposed as `contrail.changes`. */
export class ChangeConsumers {
  constructor(
    private readonly config: ContrailConfig,
    private readonly database: DatabaseResolver,
  ) {}

  register(consumerId: string, db?: Database): Promise<void> {
    return registerChangeConsumer(this.database(db), this.config, consumerId);
  }

  claim(
    consumerId: string,
    options?: ChangeClaimOptions,
    db?: Database,
  ): Promise<ChangeClaim | null> {
    return claimChanges(this.database(db), consumerId, options);
  }

  claimBootstrapChanges(
    consumerId: string,
    options?: ChangeClaimOptions,
    db?: Database,
  ): Promise<ChangeClaim | null> {
    return claimCurrentBootstrapChanges(
      this.database(db),
      consumerId,
      options,
    );
  }

  claimSnapshotPage(
    consumerId: string,
    options?: CurrentBootstrapClaimOptions,
    db?: Database,
  ): Promise<CurrentSnapshotClaim | null> {
    return claimCurrentSnapshotPage(
      this.database(db),
      this.config,
      consumerId,
      options,
    );
  }

  ackSnapshotPage(
    claim: CurrentSnapshotClaim,
    options?: { now?: number },
    db?: Database,
  ): Promise<void> {
    return acknowledgeCurrentSnapshotPage(this.database(db), claim, options);
  }

  failSnapshotPage(
    claim: CurrentSnapshotClaim,
    failure: ChangeFailure,
    options?: { now?: number },
    db?: Database,
  ): Promise<void> {
    return failCurrentSnapshotPage(
      this.database(db),
      claim,
      failure,
      options,
    );
  }

  claimActivation(
    consumerId: string,
    options?: { leaseMs?: number; now?: number },
    db?: Database,
  ): Promise<CurrentActivationClaim | null> {
    return claimCurrentActivation(this.database(db), consumerId, options);
  }

  completeActivation(
    claim: CurrentActivationClaim,
    options?: { now?: number },
    db?: Database,
  ): Promise<void> {
    return completeCurrentActivation(this.database(db), claim, options);
  }

  renewBootstrap<T extends CurrentSnapshotClaim | CurrentActivationClaim>(
    claim: T,
    options?: { leaseMs?: number; now?: number },
    db?: Database,
  ): Promise<T> {
    return renewCurrentBootstrapClaim(this.database(db), claim, options);
  }

  failActivation(
    claim: CurrentActivationClaim,
    failure: ChangeFailure,
    options?: { now?: number },
    db?: Database,
  ): Promise<void> {
    return failCurrentActivation(
      this.database(db),
      claim,
      failure,
      options,
    );
  }

  bootstrapStatus(
    consumerId: string,
    db?: Database,
  ): Promise<CurrentBootstrapStatus> {
    return getCurrentBootstrapStatus(this.database(db), consumerId);
  }

  hydrate(claim: ChangeClaim, db?: Database): Promise<DeliveryBatch> {
    return hydrateChanges(this.database(db), this.config, claim);
  }

  ack(
    claim: ChangeClaim,
    options?: { now?: number },
    db?: Database,
  ): Promise<void> {
    return acknowledgeChanges(this.database(db), claim, options);
  }

  renew(
    claim: ChangeClaim,
    options?: { leaseMs?: number; now?: number },
    db?: Database,
  ): Promise<ChangeClaim> {
    return renewChangeClaim(this.database(db), claim, options);
  }

  fail(
    claim: ChangeClaim,
    failure: ChangeFailure,
    options?: { now?: number },
    db?: Database,
  ): Promise<{ attempts: number; nextAttemptAt: number | null }> {
    return failChanges(this.database(db), claim, failure, options);
  }

  retry(
    consumerId: string,
    options?: { now?: number },
    db?: Database,
  ): Promise<void> {
    return retryChangeConsumer(this.database(db), consumerId, options);
  }

  status(db?: Database): Promise<ChangeLogStatus> {
    return getChangesStatus(this.database(db));
  }

  readiness(
    through?: string,
    db?: Database,
  ): Promise<RequiredChangeConsumerReadiness> {
    return getRequiredChangeConsumerReadiness(this.database(db), through);
  }

  skip(
    consumerId: string,
    options: SkipChangeConsumerOptions,
    db?: Database,
  ): Promise<void> {
    return skipChangeConsumer(this.database(db), consumerId, options);
  }

  prune(
    options?: PruneChangesOptions,
    db?: Database,
  ): Promise<PruneChangesResult> {
    return pruneChanges(this.database(db), options);
  }
}
