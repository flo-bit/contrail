import type { ContrailConfig, Database } from "./types";
import { recordsTableName, resolveCollectionKey } from "./types";
import type { ChangeFailure, CurrentRecord } from "./changes";
import {
  ChangeConsumerNotFoundError,
  ChangeGenerationMismatchError,
  ChangeLeaseLostError,
} from "./changes";
import { getChangeLogState } from "./change-log";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;
const FAILURE_CODE = /^[a-zA-Z0-9_.:-]{1,64}$/;

export interface CurrentBootstrapClaimOptions {
  pageSize?: number;
  leaseMs?: number;
  /** @internal Deterministic clock seam for conformance tests. */
  now?: number;
}

export interface CurrentSnapshotClaim {
  kind: "snapshot";
  consumerId: string;
  generation: string;
  bootstrapToken: string;
  collection: string;
  fromUri: string | null;
  throughUri: string;
  pageId: string;
  records: CurrentRecord[];
  attempt: number;
  leaseExpiresAt: number;
  readonly leaseOwner: string;
}

export interface CurrentActivationClaim {
  kind: "activation";
  consumerId: string;
  generation: string;
  bootstrapToken: string;
  target: string;
  attempt: number;
  leaseExpiresAt: number;
  readonly leaseOwner: string;
}

export interface CurrentBootstrapStatus {
  consumerId: string;
  generation: string;
  state: string;
  anchor: string | null;
  scanCollection: string | null;
  scanCursor: string | null;
  target: string | null;
  token: string | null;
  position: string;
}

interface BootstrapRow {
  consumer_id: string;
  generation_id: string;
  acknowledged_position: number | string;
  configured_collections_json: string;
  initial_mode: string;
  bootstrap_state: string;
  bootstrap_anchor_position: number | string | null;
  bootstrap_scan_collection: string | null;
  bootstrap_scan_cursor: string | null;
  bootstrap_target_position: number | string | null;
  bootstrap_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | string | null;
  attempts: number | string;
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

function now(value: number | undefined): number {
  const result = value ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("now must be a non-negative safe integer");
  }
  return result;
}

function parseCollections(value: string, consumerId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Current consumer ${consumerId} collections are not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(`Current consumer ${consumerId} collections are malformed`);
  }
  return [...parsed].sort();
}

async function bootstrapRow(
  db: Database,
  consumerId: string,
): Promise<BootstrapRow | null> {
  return db
    .prepare(
      `SELECT consumer_id, generation_id, acknowledged_position,
              configured_collections_json, initial_mode, bootstrap_state,
              bootstrap_anchor_position, bootstrap_scan_collection,
              bootstrap_scan_cursor, bootstrap_target_position,
              bootstrap_token, lease_owner, lease_expires_at, attempts
       FROM change_consumers WHERE consumer_id = ?`,
    )
    .bind(consumerId)
    .first<BootstrapRow>();
}

async function release(
  db: Database,
  consumerId: string,
  generation: string,
  owner: string,
  timestamp: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE change_consumers
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE consumer_id = ? AND generation_id = ? AND lease_owner = ?`,
    )
    .bind(timestamp, consumerId, generation, owner)
    .run();
}

function currentRecord(
  row: {
    uri: string;
    did: string;
    rkey: string;
    cid: string | null;
    record: string;
    time_us: number | string;
    indexed_at: number | string;
  },
  collection: string,
): CurrentRecord {
  let value: unknown;
  try {
    value = JSON.parse(row.record);
  } catch {
    throw new Error(`Current record ${row.uri} is not valid JSON`);
  }
  return {
    uri: row.uri,
    did: row.did,
    collection,
    rkey: row.rkey,
    cid: row.cid,
    value,
    timeUs: Number(row.time_us),
    indexedAt: Number(row.indexed_at),
  };
}

/** Claim one stable URI-keyset page. Empty collections advance internally;
 * exhausting the final collection atomically pins the catch-up target. */
export async function claimCurrentSnapshotPage(
  db: Database,
  config: ContrailConfig,
  consumerId: string,
  options: CurrentBootstrapClaimOptions = {},
): Promise<CurrentSnapshotClaim | null> {
  const pageSize = integer(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE,
    "pageSize",
  );
  const leaseMs = integer(
    options.leaseMs,
    DEFAULT_LEASE_MS,
    1,
    MAX_LEASE_MS,
    "leaseMs",
  );
  const timestamp = now(options.now);

  const configured = config.changes?.consumers[consumerId];
  if (!configured || configured.initial !== "current") {
    throw new ChangeConsumerNotFoundError(
      `Current-state change consumer ${consumerId} is not configured`,
    );
  }
  const expectedCollections = [...configured.collections].sort();

  for (let step = 0; step <= expectedCollections.length; step++) {
    const owner = crypto.randomUUID();
    const expires = timestamp + leaseMs;
    const leased = await db
      .prepare(
        `UPDATE change_consumers
         SET bootstrap_state = 'scanning',
             bootstrap_scan_collection = CASE
               WHEN bootstrap_state = 'pending' THEN ?
               ELSE bootstrap_scan_collection END,
             bootstrap_scan_cursor = CASE
               WHEN bootstrap_state = 'pending' THEN NULL
               ELSE bootstrap_scan_cursor END,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE consumer_id = ? AND initial_mode = 'current'
           AND bootstrap_state IN ('pending', 'scanning')
           AND generation_id = (
             SELECT generation_id FROM change_log_state WHERE id = 1
           )
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (lease_owner IS NULL OR lease_expires_at <= ?)
         RETURNING consumer_id, generation_id, acknowledged_position,
                   configured_collections_json, initial_mode, bootstrap_state,
                   bootstrap_anchor_position, bootstrap_scan_collection,
                   bootstrap_scan_cursor, bootstrap_target_position,
                   bootstrap_token, lease_owner, lease_expires_at, attempts`,
      )
      .bind(
        expectedCollections[0],
        owner,
        expires,
        timestamp,
        consumerId,
        timestamp,
        timestamp,
      )
      .first<BootstrapRow>();
    if (!leased) {
      const durable = await bootstrapRow(db, consumerId);
      if (!durable) {
        throw new ChangeConsumerNotFoundError(
          `Current-state change consumer ${consumerId} is not initialized`,
        );
      }
      const state = await getChangeLogState(db);
      if (state && durable.generation_id !== state.generation) {
        throw new ChangeGenerationMismatchError(
          `Current-state consumer ${consumerId} belongs to another generation`,
        );
      }
      return null;
    }
    if (!leased.bootstrap_token || !leased.bootstrap_scan_collection) {
      await release(db, consumerId, leased.generation_id, owner, timestamp);
      throw new Error(`Current-state change consumer ${consumerId} is malformed`);
    }
    const durableCollections = parseCollections(
      leased.configured_collections_json,
      consumerId,
    );
    if (JSON.stringify(durableCollections) !== JSON.stringify(expectedCollections)) {
      await release(db, consumerId, leased.generation_id, owner, timestamp);
      throw new Error(`Current-state change consumer ${consumerId} changed collections`);
    }
    const collectionIndex = expectedCollections.indexOf(
      leased.bootstrap_scan_collection,
    );
    if (collectionIndex < 0) {
      await release(db, consumerId, leased.generation_id, owner, timestamp);
      throw new Error(`Current-state change consumer ${consumerId} has an invalid scan collection`);
    }
    const short = resolveCollectionKey(config, leased.bootstrap_scan_collection);
    if (!short) {
      await release(db, consumerId, leased.generation_id, owner, timestamp);
      throw new Error(`Current-state scan collection is not configured`);
    }
    const table = recordsTableName(short);
    const result = leased.bootstrap_scan_cursor === null
      ? await db
          .prepare(
            `SELECT uri, did, rkey, cid, record, time_us, indexed_at
             FROM ${table} ORDER BY uri LIMIT ?`,
          )
          .bind(pageSize)
          .all<{
            uri: string;
            did: string;
            rkey: string;
            cid: string | null;
            record: string;
            time_us: number | string;
            indexed_at: number | string;
          }>()
      : await db
          .prepare(
            `SELECT uri, did, rkey, cid, record, time_us, indexed_at
             FROM ${table} WHERE uri > ? ORDER BY uri LIMIT ?`,
          )
          .bind(leased.bootstrap_scan_cursor, pageSize)
          .all<{
            uri: string;
            did: string;
            rkey: string;
            cid: string | null;
            record: string;
            time_us: number | string;
            indexed_at: number | string;
          }>();

    if (result.results.length > 0) {
      const records = result.results.map((row) =>
        currentRecord(row, leased.bootstrap_scan_collection!),
      );
      const throughUri = records.at(-1)!.uri;
      return {
        kind: "snapshot",
        consumerId,
        generation: leased.generation_id,
        bootstrapToken: leased.bootstrap_token,
        collection: leased.bootstrap_scan_collection,
        fromUri: leased.bootstrap_scan_cursor,
        throughUri,
        pageId:
          `${leased.bootstrap_token}:snapshot:` +
          `${leased.bootstrap_scan_collection}:${throughUri}`,
        records,
        attempt: Number(leased.attempts) + 1,
        leaseExpiresAt: expires,
        leaseOwner: owner,
      };
    }

    const nextCollection = expectedCollections[collectionIndex + 1] ?? null;
    if (nextCollection !== null) {
      await db
        .prepare(
          `UPDATE change_consumers
           SET bootstrap_scan_collection = ?, bootstrap_scan_cursor = NULL,
               lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE consumer_id = ? AND generation_id = ?
             AND bootstrap_state = 'scanning' AND lease_owner = ?`,
        )
        .bind(
          nextCollection,
          timestamp,
          consumerId,
          leased.generation_id,
          owner,
        )
        .run();
      continue;
    }

    await db
      .prepare(
        `UPDATE change_consumers
         SET bootstrap_state = 'catching-up',
             bootstrap_target_position = (
               SELECT head_position FROM change_log_state WHERE id = 1
             ),
             bootstrap_scan_collection = NULL, bootstrap_scan_cursor = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE consumer_id = ? AND generation_id = ?
           AND bootstrap_state = 'scanning' AND lease_owner = ?`,
      )
      .bind(timestamp, consumerId, leased.generation_id, owner)
      .run();
    return null;
  }
  return null;
}

export async function acknowledgeCurrentSnapshotPage(
  db: Database,
  claim: CurrentSnapshotClaim,
  options: { now?: number } = {},
): Promise<void> {
  const timestamp = now(options.now);
  const acknowledged = await db
    .prepare(
      `UPDATE change_consumers
       SET bootstrap_scan_cursor = ?, lease_owner = NULL,
           lease_expires_at = NULL, attempts = 0, next_attempt_at = NULL,
           last_success_at = ?, last_error_code = NULL, last_error_at = NULL,
           updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND bootstrap_state = 'scanning' AND bootstrap_token = ?
         AND bootstrap_scan_collection = ?
         AND ((bootstrap_scan_cursor = ?) OR
              (bootstrap_scan_cursor IS NULL AND CAST(? AS TEXT) IS NULL))
         AND lease_owner = ? AND lease_expires_at > ?
       RETURNING consumer_id`,
    )
    .bind(
      claim.throughUri,
      timestamp,
      timestamp,
      claim.consumerId,
      claim.generation,
      claim.bootstrapToken,
      claim.collection,
      claim.fromUri,
      claim.fromUri,
      claim.leaseOwner,
      timestamp,
    )
    .first<{ consumer_id: string }>();
  if (!acknowledged) {
    throw new ChangeLeaseLostError(
      `Current snapshot claim for ${claim.consumerId} is stale or expired`,
    );
  }
}

async function failBootstrapLease(
  db: Database,
  claim: CurrentSnapshotClaim | CurrentActivationClaim,
  failure: ChangeFailure,
  timestamp: number,
): Promise<void> {
  if (!FAILURE_CODE.test(failure.code)) {
    throw new TypeError(
      "Change failure code must contain 1-64 safe identifier characters",
    );
  }
  if (
    failure.nextAttemptAt !== null &&
    (!Number.isSafeInteger(failure.nextAttemptAt) ||
      failure.nextAttemptAt < timestamp)
  ) {
    throw new TypeError("nextAttemptAt must be null or a future safe timestamp");
  }
  // Expiry permits reclamation; owner equality remains the CAS guard. Preserve
  // failure/backoff when slow work expires but no replacement has claimed it.
  const failed = await db
    .prepare(
      `UPDATE change_consumers
       SET lease_owner = NULL, lease_expires_at = NULL,
           attempts = attempts + 1, next_attempt_at = ?,
           last_error_code = ?, last_error_at = ?, updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND bootstrap_token = ? AND lease_owner = ?
       RETURNING consumer_id`,
    )
    .bind(
      failure.nextAttemptAt,
      failure.code,
      timestamp,
      timestamp,
      claim.consumerId,
      claim.generation,
      claim.bootstrapToken,
      claim.leaseOwner,
    )
    .first<{ consumer_id: string }>();
  if (!failed) {
    throw new ChangeLeaseLostError(
      `Current bootstrap claim for ${claim.consumerId} is stale or no longer owned`,
    );
  }
}

export function failCurrentSnapshotPage(
  db: Database,
  claim: CurrentSnapshotClaim,
  failure: ChangeFailure,
  options: { now?: number } = {},
): Promise<void> {
  return failBootstrapLease(db, claim, failure, now(options.now));
}

export async function renewCurrentBootstrapClaim<
  T extends CurrentSnapshotClaim | CurrentActivationClaim,
>(
  db: Database,
  claim: T,
  options: { leaseMs?: number; now?: number } = {},
): Promise<T> {
  const timestamp = now(options.now);
  const leaseMs = integer(
    options.leaseMs,
    DEFAULT_LEASE_MS,
    1,
    MAX_LEASE_MS,
    "leaseMs",
  );
  const expires = timestamp + leaseMs;
  const renewed = await db
    .prepare(
      `UPDATE change_consumers
       SET lease_expires_at = ?, updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND bootstrap_token = ? AND lease_owner = ?
         AND lease_expires_at > ?
       RETURNING consumer_id`,
    )
    .bind(
      expires,
      timestamp,
      claim.consumerId,
      claim.generation,
      claim.bootstrapToken,
      claim.leaseOwner,
      timestamp,
    )
    .first<{ consumer_id: string }>();
  if (!renewed) {
    throw new ChangeLeaseLostError(
      `Current bootstrap claim for ${claim.consumerId} cannot be renewed`,
    );
  }
  return { ...claim, leaseExpiresAt: expires };
}

/** Claim the idempotent destination-activation step after fixed-target catch-up. */
export async function claimCurrentActivation(
  db: Database,
  consumerId: string,
  options: { leaseMs?: number; now?: number } = {},
): Promise<CurrentActivationClaim | null> {
  const timestamp = now(options.now);
  const leaseMs = integer(
    options.leaseMs,
    DEFAULT_LEASE_MS,
    1,
    MAX_LEASE_MS,
    "leaseMs",
  );
  const owner = crypto.randomUUID();
  const expires = timestamp + leaseMs;
  const row = await db
    .prepare(
      `UPDATE change_consumers
       SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE consumer_id = ? AND initial_mode = 'current'
         AND bootstrap_state = 'activating'
         AND generation_id = (
           SELECT generation_id FROM change_log_state WHERE id = 1
         )
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (lease_owner IS NULL OR lease_expires_at <= ?)
       RETURNING consumer_id, generation_id, acknowledged_position,
                 configured_collections_json, initial_mode, bootstrap_state,
                 bootstrap_anchor_position, bootstrap_scan_collection,
                 bootstrap_scan_cursor, bootstrap_target_position,
                 bootstrap_token, lease_owner, lease_expires_at, attempts`,
    )
    .bind(owner, expires, timestamp, consumerId, timestamp, timestamp)
    .first<BootstrapRow>();
  if (!row) {
    const durable = await bootstrapRow(db, consumerId);
    const state = await getChangeLogState(db);
    if (durable && state && durable.generation_id !== state.generation) {
      throw new ChangeGenerationMismatchError(
        `Current-state consumer ${consumerId} belongs to another generation`,
      );
    }
    return null;
  }
  if (!row.bootstrap_token || row.bootstrap_target_position === null) {
    await release(db, consumerId, row.generation_id, owner, timestamp);
    throw new Error(`Current activation ${consumerId} is malformed`);
  }
  return {
    kind: "activation",
    consumerId,
    generation: row.generation_id,
    bootstrapToken: row.bootstrap_token,
    target: String(row.bootstrap_target_position),
    attempt: Number(row.attempts) + 1,
    leaseExpiresAt: expires,
    leaseOwner: owner,
  };
}

export async function completeCurrentActivation(
  db: Database,
  claim: CurrentActivationClaim,
  options: { now?: number } = {},
): Promise<void> {
  const timestamp = now(options.now);
  const completed = await db
    .prepare(
      `UPDATE change_consumers
       SET bootstrap_state = 'ready', lease_owner = NULL,
           lease_expires_at = NULL, attempts = 0, next_attempt_at = NULL,
           last_success_at = ?, last_error_code = NULL, last_error_at = NULL,
           updated_at = ?
       WHERE consumer_id = ? AND generation_id = ?
         AND bootstrap_state = 'activating' AND bootstrap_token = ?
         AND bootstrap_target_position = ?
         AND acknowledged_position = bootstrap_target_position
         AND lease_owner = ? AND lease_expires_at > ?
       RETURNING consumer_id`,
    )
    .bind(
      timestamp,
      timestamp,
      claim.consumerId,
      claim.generation,
      claim.bootstrapToken,
      claim.target,
      claim.leaseOwner,
      timestamp,
    )
    .first<{ consumer_id: string }>();
  if (!completed) {
    throw new ChangeLeaseLostError(
      `Current activation claim for ${claim.consumerId} is stale or expired`,
    );
  }
}

export function failCurrentActivation(
  db: Database,
  claim: CurrentActivationClaim,
  failure: ChangeFailure,
  options: { now?: number } = {},
): Promise<void> {
  return failBootstrapLease(db, claim, failure, now(options.now));
}

export async function getCurrentBootstrapStatus(
  db: Database,
  consumerId: string,
): Promise<CurrentBootstrapStatus> {
  const row = await bootstrapRow(db, consumerId);
  if (!row || row.initial_mode !== "current") {
    throw new ChangeConsumerNotFoundError(
      `Current-state change consumer ${consumerId} is not initialized`,
    );
  }
  return {
    consumerId,
    generation: row.generation_id,
    state: row.bootstrap_state,
    anchor:
      row.bootstrap_anchor_position === null
        ? null
        : String(row.bootstrap_anchor_position),
    scanCollection: row.bootstrap_scan_collection,
    scanCursor: row.bootstrap_scan_cursor,
    target:
      row.bootstrap_target_position === null
        ? null
        : String(row.bootstrap_target_position),
    token: row.bootstrap_token,
    position: String(row.acknowledged_position),
  };
}
