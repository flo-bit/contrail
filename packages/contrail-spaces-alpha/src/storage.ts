import type { ContrailConfig, Database, Statement } from "@atmo-dev/contrail";
import {
  deleteIsolatedScope,
  initIsolatedProjection,
} from "@atmo-dev/contrail";
import { decryptJson, encryptJson, type EncryptedValue } from "./crypto";
import type { StoredSpaceCredential } from "./protocol";
import { parseSpaceUri, spaceProjectionKey } from "./uri";

export type WatchStatus = "active" | "paused" | "hidden";

export interface SpaceWatch {
  spaceUri: string;
  authorityDid: string;
  spaceType: string;
  generation: number;
  status: WatchStatus;
  registrationExpiresAt: string | null;
  registrationPdsUrl: string | null;
  nextReconcileAt: number;
  lastReconciledAt: number | null;
  lastError: string | null;
  /** Last authority space revision whose writer updates were all processed. */
  spaceRev: string | null;
  /** Consecutive failed reconciliations, for Space-level backoff. */
  consecutiveFailures: number;
  lastFullReconcileAt: number | null;
}

export interface SpaceRepoState {
  spaceUri: string;
  spaceGeneration: number;
  repoDid: string;
  pdsUrl: string;
  visibleWriterGeneration: number;
  rev: string;
  ltHash: Uint8Array;
  commitHash: Uint8Array;
}

/** A writer whose repo host could not be synchronized. This also serves as the
 * retry list for incremental reconciliation, which no longer lists every
 * writer on every pass. */
export interface SpaceRepoFailure {
  repoDid: string;
  failures: number;
  retryAfter: number;
  lastError: string;
}

export async function initSpacesStorage(
  db: Database,
  projection: ContrailConfig,
): Promise<void> {
  await initIsolatedProjection(db, projection);
  const bigint = db.dialect?.bigintType ?? "INTEGER";
  const statements = [
    `CREATE TABLE IF NOT EXISTS spaces_transaction_guard (
      ok INTEGER NOT NULL CONSTRAINT spaces_sync_fence CHECK (ok = 1)
    )`,
    `CREATE TABLE IF NOT EXISTS spaces_watches (
      space_uri TEXT PRIMARY KEY,
      authority_did TEXT NOT NULL,
      space_type TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      registration_expires_at TEXT,
      registration_pds_url TEXT,
      next_reconcile_at ${bigint} NOT NULL,
      last_reconciled_at ${bigint},
      last_error TEXT,
      space_rev TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_full_reconcile_at ${bigint},
      created_at ${bigint} NOT NULL,
      updated_at ${bigint} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_watches_due
      ON spaces_watches(status, next_reconcile_at)`,
    `CREATE TABLE IF NOT EXISTS spaces_repo_state (
      space_uri TEXT NOT NULL,
      space_generation INTEGER NOT NULL,
      repo_did TEXT NOT NULL,
      pds_url TEXT NOT NULL,
      visible_writer_generation INTEGER NOT NULL,
      rev TEXT NOT NULL,
      lt_hash BLOB NOT NULL,
      commit_hash BLOB NOT NULL,
      updated_at ${bigint} NOT NULL,
      PRIMARY KEY (space_uri, space_generation, repo_did)
    )`,
    `CREATE TABLE IF NOT EXISTS spaces_repo_failures (
      space_uri TEXT NOT NULL,
      space_generation INTEGER NOT NULL,
      repo_did TEXT NOT NULL,
      failures INTEGER NOT NULL,
      retry_after ${bigint} NOT NULL,
      last_error TEXT NOT NULL,
      updated_at ${bigint} NOT NULL,
      PRIMARY KEY (space_uri, space_generation, repo_did)
    )`,
    `CREATE TABLE IF NOT EXISTS spaces_access_leases (
      user_did TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      space_generation INTEGER NOT NULL,
      expires_at ${bigint} NOT NULL,
      evidence TEXT NOT NULL,
      created_at ${bigint} NOT NULL,
      PRIMARY KEY (user_did, space_uri, space_generation)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_access_expiry
      ON spaces_access_leases(expires_at)`,
    `CREATE TABLE IF NOT EXISTS spaces_credentials (
      space_uri TEXT NOT NULL,
      space_generation INTEGER NOT NULL,
      viewer_did TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      expires_at ${bigint} NOT NULL,
      updated_at ${bigint} NOT NULL,
      PRIMARY KEY (space_uri, space_generation)
    )`,
    `CREATE TABLE IF NOT EXISTS spaces_sync_leases (
      space_uri TEXT NOT NULL,
      space_generation INTEGER NOT NULL,
      repo_did TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at ${bigint} NOT NULL,
      PRIMARY KEY (space_uri, space_generation, repo_did)
    )`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
}

function rowToWatch(row: Record<string, unknown>): SpaceWatch {
  return {
    spaceUri: String(row.space_uri),
    authorityDid: String(row.authority_did),
    spaceType: String(row.space_type),
    generation: Number(row.generation),
    status: String(row.status) as WatchStatus,
    registrationExpiresAt:
      row.registration_expires_at === null
        ? null
        : String(row.registration_expires_at),
    registrationPdsUrl:
      row.registration_pds_url == null
        ? null
        : String(row.registration_pds_url),
    nextReconcileAt: Number(row.next_reconcile_at),
    lastReconciledAt:
      row.last_reconciled_at === null ? null : Number(row.last_reconciled_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    spaceRev: row.space_rev == null ? null : String(row.space_rev),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastFullReconcileAt:
      row.last_full_reconcile_at == null
        ? null
        : Number(row.last_full_reconcile_at),
  };
}

export async function getSpaceWatch(
  db: Database,
  spaceUri: string,
): Promise<SpaceWatch | null> {
  const row = await db
    .prepare(
      `SELECT space_uri, authority_did, space_type, generation, status,
            registration_expires_at, registration_pds_url, next_reconcile_at, last_reconciled_at, last_error,
            space_rev, consecutive_failures, last_full_reconcile_at
     FROM spaces_watches WHERE space_uri = ?`,
    )
    .bind(spaceUri)
    .first<Record<string, unknown>>();
  return row ? rowToWatch(row) : null;
}

export async function ensureSpaceWatch(
  db: Database,
  input: { spaceUri: string; reconcileAt?: number },
): Promise<SpaceWatch> {
  const parsed = parseSpaceUri(input.spaceUri);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO spaces_watches
       (space_uri, authority_did, space_type, generation, status,
        next_reconcile_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?, ?)
     ON CONFLICT(space_uri) DO UPDATE SET
       authority_did = excluded.authority_did,
       space_type = excluded.space_type,
       status = CASE WHEN spaces_watches.status = 'hidden'
         THEN spaces_watches.status ELSE 'active' END,
       next_reconcile_at = CASE WHEN spaces_watches.next_reconcile_at < excluded.next_reconcile_at
         THEN spaces_watches.next_reconcile_at ELSE excluded.next_reconcile_at END,
       updated_at = excluded.updated_at`,
    )
    .bind(
      input.spaceUri,
      parsed.authorityDid,
      parsed.type,
      input.reconcileAt ?? now,
      now,
      now,
    )
    .run();
  const watch = await getSpaceWatch(db, input.spaceUri);
  if (!watch) throw new Error("Could not retain Space watch");
  if (watch.status === "hidden") {
    throw new Error("Deleted Space requires explicit rediscovery");
  }
  return watch;
}

export async function rediscoverSpace(
  db: Database,
  spaceUri: string,
): Promise<SpaceWatch> {
  const parsed = parseSpaceUri(spaceUri);
  const hidden = await getSpaceWatch(db, spaceUri);
  if (!hidden || hidden.status !== "hidden") {
    throw new Error("Only a previously deleted Space can be rediscovered");
  }
  const now = Date.now();
  // hideDeletedSpace already advanced the generation before making the watch
  // hidden. Rediscovery activates that fresh, empty generation exactly once.
  const nextGeneration = hidden.generation;
  await db
    .prepare(
      `UPDATE spaces_watches SET
       authority_did = ?, space_type = ?, generation = ?, status = 'active',
       registration_expires_at = NULL, registration_pds_url = NULL, next_reconcile_at = ?,
       last_reconciled_at = NULL, last_error = NULL, space_rev = NULL,
       consecutive_failures = 0, last_full_reconcile_at = NULL, updated_at = ?
     WHERE space_uri = ? AND generation = ? AND status = 'hidden'`,
    )
    .bind(
      parsed.authorityDid,
      parsed.type,
      nextGeneration,
      now,
      now,
      spaceUri,
      hidden.generation,
    )
    .run();
  const watch = await getSpaceWatch(db, spaceUri);
  if (
    !watch ||
    watch.status !== "active" ||
    watch.generation !== nextGeneration
  ) {
    throw new Error(
      "Concurrent Space rediscovery changed the watch generation",
    );
  }
  return watch;
}

export async function listConnectedSpaceWatches(
  db: Database,
  input: { userDid: string; cursor?: string; limit: number; now?: number },
): Promise<SpaceWatch[]> {
  const limit = Math.max(1, Math.min(201, Math.trunc(input.limit)));
  const rows = await db
    .prepare(
      `SELECT space_uri, authority_did, space_type, generation, status,
            registration_expires_at, registration_pds_url, next_reconcile_at, last_reconciled_at, last_error,
            space_rev, consecutive_failures, last_full_reconcile_at
     FROM spaces_watches watch
     WHERE watch.status = 'active' AND watch.space_uri > ?
       AND (
         watch.authority_did = ?
         OR EXISTS (
           SELECT 1 FROM spaces_access_leases access
           WHERE access.space_uri = watch.space_uri
             AND access.space_generation = watch.generation
             AND access.user_did = ? AND access.expires_at > ?
         )
       )
     ORDER BY watch.space_uri
     LIMIT ?`,
    )
    .bind(
      input.cursor ?? "",
      input.userDid,
      input.userDid,
      input.now ?? Date.now(),
      limit,
    )
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToWatch);
}

export async function listDueWatches(
  db: Database,
  now: number,
  limit: number,
): Promise<SpaceWatch[]> {
  const rows = await db
    .prepare(
      `SELECT space_uri, authority_did, space_type, generation, status,
            registration_expires_at, registration_pds_url, next_reconcile_at, last_reconciled_at, last_error,
            space_rev, consecutive_failures, last_full_reconcile_at
     FROM spaces_watches
     WHERE status = 'active' AND next_reconcile_at <= ?
     ORDER BY next_reconcile_at, space_uri LIMIT ?`,
    )
    .bind(now, limit)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToWatch);
}

export async function updateWatch(
  db: Database,
  spaceUri: string,
  input: {
    registrationExpiresAt?: string | null;
    registrationPdsUrl?: string | null;
    nextReconcileAt?: number;
    reconciledAt?: number;
    error?: string | null;
    status?: WatchStatus;
    consecutiveFailures?: number;
    fullReconciledAt?: number;
    /** Ignore stale work from a prior deletion/rediscovery generation. */
    expectedGeneration?: number;
    expectedStatus?: WatchStatus;
  },
): Promise<void> {
  const current = await getSpaceWatch(db, spaceUri);
  if (!current) return;
  const generationGuard =
    input.expectedGeneration === undefined ? "" : " AND generation = ?";
  const statusGuard =
    input.expectedStatus === undefined ? "" : " AND status = ?";
  const statement = db
    .prepare(
      `UPDATE spaces_watches SET
      registration_expires_at = ?, registration_pds_url = ?, next_reconcile_at = ?,
      last_reconciled_at = ?, last_error = ?, status = ?,
      consecutive_failures = ?, last_full_reconcile_at = ?, updated_at = ?
     WHERE space_uri = ?${generationGuard}${statusGuard}`,
    )
    .bind(
      input.registrationExpiresAt === undefined
        ? current.registrationExpiresAt
        : input.registrationExpiresAt,
      input.registrationPdsUrl === undefined
        ? current.registrationPdsUrl
        : input.registrationPdsUrl,
      input.nextReconcileAt ?? current.nextReconcileAt,
      input.reconciledAt === undefined
        ? current.lastReconciledAt
        : input.reconciledAt,
      input.error === undefined ? current.lastError : input.error,
      input.status ?? current.status,
      input.consecutiveFailures ?? current.consecutiveFailures,
      input.fullReconciledAt ?? current.lastFullReconcileAt,
      Date.now(),
      spaceUri,
      ...(input.expectedGeneration === undefined
        ? []
        : [input.expectedGeneration]),
      ...(input.expectedStatus === undefined ? [] : [input.expectedStatus]),
    );
  await statement.run();
}

function credentialContext(spaceUri: string, generation: number): string {
  return `contrail-spaces-alpha:credential:${spaceProjectionKey(spaceUri, generation)}`;
}

export async function saveCredential(
  db: Database,
  input: {
    spaceUri: string;
    generation: number;
    viewerDid: string;
    credential: StoredSpaceCredential;
    encryptionKey: string;
  },
): Promise<void> {
  const encrypted = await encryptJson(
    input.credential,
    input.encryptionKey,
    credentialContext(input.spaceUri, input.generation),
  );
  await db
    .prepare(
      `INSERT INTO spaces_credentials
       (space_uri, space_generation, viewer_did, encrypted_value, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation) DO UPDATE SET
       viewer_did = excluded.viewer_did,
       encrypted_value = excluded.encrypted_value,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    )
    .bind(
      input.spaceUri,
      input.generation,
      input.viewerDid,
      JSON.stringify(encrypted),
      input.credential.expiresAt,
      Date.now(),
    )
    .run();
}

export async function loadCredential(
  db: Database,
  input: { spaceUri: string; generation: number; encryptionKey: string },
): Promise<{
  viewerDid: string;
  credential: StoredSpaceCredential;
  /** Opaque compare-and-delete token; never expose it to a caller. */
  encryptedValue: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT viewer_did, encrypted_value, expires_at FROM spaces_credentials
     WHERE space_uri = ? AND space_generation = ?`,
    )
    .bind(input.spaceUri, input.generation)
    .first<{
      viewer_did: string;
      encrypted_value: string;
      expires_at: number;
    }>();
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  const credential = await decryptJson<StoredSpaceCredential>(
    JSON.parse(row.encrypted_value) as EncryptedValue,
    input.encryptionKey,
    credentialContext(input.spaceUri, input.generation),
  );
  if (credential.expiresAt <= Date.now()) return null;
  return {
    viewerDid: row.viewer_did,
    credential,
    encryptedValue: row.encrypted_value,
  };
}

/** Invalidate only the credential that failed, not a concurrent replacement.
 * Pausing fences in-flight projection writes without purging verified content. */
export async function invalidateRevokedCredential(
  db: Database,
  input: { spaceUri: string; generation: number; encryptedValue: string },
): Promise<void> {
  const matches = `EXISTS (
    SELECT 1 FROM spaces_credentials credential
    WHERE credential.space_uri = ? AND credential.space_generation = ?
      AND credential.encrypted_value = ?
  )`;
  const bindings = [input.spaceUri, input.generation, input.encryptedValue];
  await db.batch([
    db
      .prepare(
        `UPDATE spaces_watches SET status = 'paused',
       last_error = 'Space credential revoked; reauthorization required', updated_at = ?
       WHERE space_uri = ? AND generation = ? AND ${matches}`,
      )
      .bind(Date.now(), input.spaceUri, input.generation, ...bindings),
    db
      .prepare(
        `DELETE FROM spaces_access_leases
       WHERE space_uri = ? AND space_generation = ? AND user_did = (
         SELECT viewer_did FROM spaces_credentials
         WHERE space_uri = ? AND space_generation = ? AND encrypted_value = ?
       )`,
      )
      .bind(input.spaceUri, input.generation, ...bindings),
    db
      .prepare(
        `DELETE FROM spaces_sync_leases
       WHERE space_uri = ? AND space_generation = ? AND ${matches}`,
      )
      .bind(input.spaceUri, input.generation, ...bindings),
    db
      .prepare(
        `DELETE FROM spaces_credentials
       WHERE space_uri = ? AND space_generation = ? AND encrypted_value = ?`,
      )
      .bind(...bindings),
  ]);
}

export async function saveAccessLease(
  db: Database,
  input: {
    userDid: string;
    spaceUri: string;
    generation: number;
    expiresAt: number;
    /** Opaque grant identity; use a fresh token for every authorization. */
    evidence?: string;
  },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO spaces_access_leases
       (user_did, space_uri, space_generation, expires_at, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_did, space_uri, space_generation) DO UPDATE SET
       expires_at = excluded.expires_at, evidence = excluded.evidence,
       created_at = excluded.created_at`,
    )
    .bind(
      input.userDid,
      input.spaceUri,
      input.generation,
      input.expiresAt,
      input.evidence ?? crypto.randomUUID(),
      now,
    )
    .run();
}

/** Snapshot the current read grant before an authorization request. Its opaque
 * evidence token lets a delayed denial preserve a concurrently replaced grant. */
export async function loadAccessLease(
  db: Database,
  input: {
    userDid: string;
    spaceUri: string;
    generation: number;
    now?: number;
  },
): Promise<{ evidence: string; expiresAt: number } | null> {
  const row = await db
    .prepare(
      `SELECT evidence, expires_at FROM spaces_access_leases
     WHERE user_did = ? AND space_uri = ? AND space_generation = ? AND expires_at > ?`,
    )
    .bind(
      input.userDid,
      input.spaceUri,
      input.generation,
      input.now ?? Date.now(),
    )
    .first<{ evidence: string; expires_at: number }>();
  return row
    ? { evidence: row.evidence, expiresAt: Number(row.expires_at) }
    : null;
}

export async function hasAccessLease(
  db: Database,
  input: {
    userDid: string;
    spaceUri: string;
    generation: number;
    now?: number;
  },
): Promise<boolean> {
  return (await loadAccessLease(db, input)) !== null;
}

/** Revoke only the exact grant observed by the failed authorization request. */
export async function invalidateAccessLease(
  db: Database,
  input: {
    userDid: string;
    spaceUri: string;
    generation: number;
    evidence: string;
  },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM spaces_access_leases
     WHERE user_did = ? AND space_uri = ? AND space_generation = ? AND evidence = ?`,
    )
    .bind(input.userDid, input.spaceUri, input.generation, input.evidence)
    .run();
}

function asBytes(value: unknown, name: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return Uint8Array.from(value as number[]);
  }
  throw new Error(`Invalid ${name} bytes in Space checkpoint`);
}

function rowToRepo(row: Record<string, unknown>): SpaceRepoState {
  return {
    spaceUri: String(row.space_uri),
    spaceGeneration: Number(row.space_generation),
    repoDid: String(row.repo_did),
    pdsUrl: String(row.pds_url),
    visibleWriterGeneration: Number(row.visible_writer_generation),
    rev: String(row.rev),
    ltHash: asBytes(row.lt_hash, "LtHash"),
    commitHash: asBytes(row.commit_hash, "commit hash"),
  };
}

export async function listRepoStates(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
): Promise<SpaceRepoState[]> {
  const rows = await db
    .prepare(
      `SELECT space_uri, space_generation, repo_did, pds_url,
            visible_writer_generation, rev, lt_hash, commit_hash
     FROM spaces_repo_state WHERE space_uri = ? AND space_generation = ?`,
    )
    .bind(watch.spaceUri, watch.generation)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToRepo);
}

export async function getRepoState(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  repoDid: string,
): Promise<SpaceRepoState | null> {
  const row = await db
    .prepare(
      `SELECT space_uri, space_generation, repo_did, pds_url,
            visible_writer_generation, rev, lt_hash, commit_hash
     FROM spaces_repo_state
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    )
    .bind(watch.spaceUri, watch.generation, repoDid)
    .first<Record<string, unknown>>();
  return row ? rowToRepo(row) : null;
}

/** Commit checkpoint metadata after projection statements in the same batch. */
export function saveRepoStateStatement(
  db: Database,
  state: SpaceRepoState,
): Statement {
  return db
    .prepare(
      `INSERT INTO spaces_repo_state
       (space_uri, space_generation, repo_did, pds_url,
        visible_writer_generation, rev, lt_hash, commit_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation, repo_did) DO UPDATE SET
       pds_url = excluded.pds_url,
       visible_writer_generation = excluded.visible_writer_generation,
       rev = excluded.rev, lt_hash = excluded.lt_hash,
       commit_hash = excluded.commit_hash,
       updated_at = excluded.updated_at`,
    )
    .bind(
      state.spaceUri,
      state.spaceGeneration,
      state.repoDid,
      state.pdsUrl,
      state.visibleWriterGeneration,
      state.rev,
      state.ltHash,
      state.commitHash,
      Date.now(),
    );
}

export async function listRepoFailures(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
): Promise<SpaceRepoFailure[]> {
  const rows = await db
    .prepare(
      `SELECT repo_did, failures, retry_after, last_error FROM spaces_repo_failures
     WHERE space_uri = ? AND space_generation = ?`,
    )
    .bind(watch.spaceUri, watch.generation)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    repoDid: String(row.repo_did),
    failures: Number(row.failures),
    retryAfter: Number(row.retry_after),
    lastError: String(row.last_error),
  }));
}

export const REPO_FAILURE_MAX_BACKOFF_MS = 60 * 60_000;

/** Record one more failure for a writer and back off exponentially (one
 * minute doubling to an hour) unless the caller supplies a fixed delay. */
export async function recordRepoFailure(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  repoDid: string,
  input: { error: string; retryInMs?: number; now?: number },
): Promise<SpaceRepoFailure> {
  const now = input.now ?? Date.now();
  const existing = await db
    .prepare(
      `SELECT failures FROM spaces_repo_failures
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    )
    .bind(watch.spaceUri, watch.generation, repoDid)
    .first<{ failures: number }>();
  const failures = Number(existing?.failures ?? 0) + 1;
  const retryAfter =
    now +
    (input.retryInMs ??
      Math.min(
        REPO_FAILURE_MAX_BACKOFF_MS,
        60_000 * 2 ** Math.min(failures - 1, 10),
      ));
  const lastError = input.error.slice(0, 500);
  await db
    .prepare(
      `INSERT INTO spaces_repo_failures
       (space_uri, space_generation, repo_did, failures, retry_after, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation, repo_did) DO UPDATE SET
       failures = excluded.failures, retry_after = excluded.retry_after,
       last_error = excluded.last_error, updated_at = excluded.updated_at`,
    )
    .bind(
      watch.spaceUri,
      watch.generation,
      repoDid,
      failures,
      retryAfter,
      lastError,
      now,
    )
    .run();
  return { repoDid, failures, retryAfter, lastError };
}

export async function clearRepoFailure(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  repoDid: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM spaces_repo_failures
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    )
    .bind(watch.spaceUri, watch.generation, repoDid)
    .run();
}

/** Move the processed-space-revision checkpoint forward, never backward.
 * With `prevSpaceRev` this only succeeds when the notification directly
 * follows the checkpoint; `false` means updates in between were missed and
 * the caller must catch up from the authority's writer listing. Revisions are
 * compared here rather than in SQL so database collation cannot reorder them. */
export async function advanceSpaceRev(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  input: { spaceRev: string; prevSpaceRev?: string; contiguousOnly?: boolean },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare(
        `SELECT space_rev FROM spaces_watches WHERE space_uri = ? AND generation = ?`,
      )
      .bind(watch.spaceUri, watch.generation)
      .first<{ space_rev: string | null }>();
    if (!row) return true;
    const current = row.space_rev ?? null;
    if (current !== null && !revBefore(current, input.spaceRev)) return true;
    if (input.contiguousOnly) {
      // No checkpoint yet: only the first update ever made in a Space can
      // establish one. Otherwise the next listing does.
      if (current === null && input.prevSpaceRev !== undefined) return true;
      if (
        current !== null &&
        (input.prevSpaceRev === undefined ||
          revBefore(current, input.prevSpaceRev))
      )
        return false;
    }
    // Compare-and-set on the value just read, so a concurrent advance wins.
    await db
      .prepare(
        `UPDATE spaces_watches SET space_rev = ?, updated_at = ?
       WHERE space_uri = ? AND generation = ?
         AND ${current === null ? "space_rev IS NULL" : "space_rev = ?"}`,
      )
      .bind(
        input.spaceRev,
        Date.now(),
        watch.spaceUri,
        watch.generation,
        ...(current === null ? [] : [current]),
      )
      .run();
  }
  return true;
}

/** Revisions are TIDs: equal-length strings that sort by time. */
export function revBefore(left: string, right: string): boolean {
  return left.length === right.length
    ? left < right
    : left.length < right.length;
}

export async function deleteRepoState(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  repoDid: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM spaces_repo_state
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    )
    .bind(watch.spaceUri, watch.generation, repoDid)
    .run();
}

export async function acquireSyncLease(
  db: Database,
  input: {
    spaceUri: string;
    generation: number;
    repoDid: string;
    owner: string;
    ttlMs?: number;
  },
): Promise<boolean> {
  const now = Date.now();
  const expires = now + (input.ttlMs ?? 60_000);
  await db
    .prepare(
      `INSERT INTO spaces_sync_leases
       (space_uri, space_generation, repo_did, owner, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation, repo_did) DO UPDATE SET
       owner = excluded.owner, expires_at = excluded.expires_at
     WHERE spaces_sync_leases.expires_at <= ? OR spaces_sync_leases.owner = ?`,
    )
    .bind(
      input.spaceUri,
      input.generation,
      input.repoDid,
      input.owner,
      expires,
      now,
      input.owner,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT owner, expires_at FROM spaces_sync_leases
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    )
    .bind(input.spaceUri, input.generation, input.repoDid)
    .first<{
      owner: string;
      expires_at: number;
    }>();
  return row?.owner === input.owner && Number(row.expires_at) === expires;
}

export async function renewSyncLease(
  db: Database,
  input: {
    spaceUri: string;
    generation: number;
    repoDid: string;
    owner: string;
    ttlMs?: number;
  },
): Promise<boolean> {
  const now = Date.now();
  const expires = now + (input.ttlMs ?? 60_000);
  await db
    .prepare(
      `UPDATE spaces_sync_leases SET expires_at = ?
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?
       AND owner = ? AND expires_at > ?`,
    )
    .bind(
      expires,
      input.spaceUri,
      input.generation,
      input.repoDid,
      input.owner,
      now,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT owner, expires_at FROM spaces_sync_leases
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    )
    .bind(input.spaceUri, input.generation, input.repoDid)
    .first<{
      owner: string;
      expires_at: number;
    }>();
  return row?.owner === input.owner && Number(row.expires_at) === expires;
}

/** Append inside each projection/checkpoint transaction. A stale worker must
 * roll back its entire batch, not just fail a check before the transaction. */
export function syncLeaseFenceStatements(
  db: Database,
  input: {
    spaceUri: string;
    generation: number;
    repoDid: string;
    owner: string;
  },
): Statement[] {
  return [
    db
      .prepare(
        `INSERT INTO spaces_transaction_guard (ok) SELECT CASE WHEN EXISTS (
      SELECT 1 FROM spaces_sync_leases l JOIN spaces_watches w ON w.space_uri = l.space_uri
      WHERE l.space_uri = ? AND l.space_generation = ? AND l.repo_did = ? AND l.owner = ?
        AND l.expires_at > ? AND w.generation = l.space_generation AND w.status = 'active'
    ) THEN 1 ELSE 0 END`,
      )
      .bind(
        input.spaceUri,
        input.generation,
        input.repoDid,
        input.owner,
        Date.now(),
      ),
    db.prepare("DELETE FROM spaces_transaction_guard"),
  ];
}

export async function releaseSyncLease(
  db: Database,
  input: {
    spaceUri: string;
    generation: number;
    repoDid: string;
    owner: string;
  },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM spaces_sync_leases
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ? AND owner = ?`,
    )
    .bind(input.spaceUri, input.generation, input.repoDid, input.owner)
    .run();
}

/** Immediately deny all reads and invalidate credentials/work for a deleted Space. */
export async function hideDeletedSpace(
  db: Database,
  watch: SpaceWatch,
): Promise<void> {
  const nextGeneration = watch.generation + 1;
  await db.batch([
    db
      .prepare(
        `UPDATE spaces_watches SET status = 'hidden', generation = ?,
       registration_expires_at = NULL, registration_pds_url = NULL, last_error = NULL, updated_at = ?
       WHERE space_uri = ? AND generation = ?`,
      )
      .bind(nextGeneration, Date.now(), watch.spaceUri, watch.generation),
    db
      .prepare(`DELETE FROM isolated_projection_partitions WHERE scope_key = ?`)
      .bind(spaceProjectionKey(watch.spaceUri, watch.generation)),
    db
      .prepare(
        `DELETE FROM spaces_access_leases
       WHERE space_uri = ? AND space_generation = ?`,
      )
      .bind(watch.spaceUri, watch.generation),
    db
      .prepare(
        `DELETE FROM spaces_credentials
       WHERE space_uri = ? AND space_generation = ?`,
      )
      .bind(watch.spaceUri, watch.generation),
    db
      .prepare(
        `DELETE FROM spaces_sync_leases
       WHERE space_uri = ? AND space_generation = ?`,
      )
      .bind(watch.spaceUri, watch.generation),
    db
      .prepare(
        `DELETE FROM spaces_repo_failures
       WHERE space_uri = ? AND space_generation = ?`,
      )
      .bind(watch.spaceUri, watch.generation),
  ]);
}

/** Complete plaintext projection/checkpoint cleanup after deletion has already
 * hidden the scope and invalidated credentials. */
export async function purgeSpaceGeneration(
  db: Database,
  projection: ContrailConfig,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
): Promise<void> {
  await deleteIsolatedScope(db, projection, {
    kind: "isolated",
    key: spaceProjectionKey(watch.spaceUri, watch.generation),
  });
  await db
    .prepare(
      `DELETE FROM spaces_repo_state
     WHERE space_uri = ? AND space_generation = ?`,
    )
    .bind(watch.spaceUri, watch.generation)
    .run();
}
