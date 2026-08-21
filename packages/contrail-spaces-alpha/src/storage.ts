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
  nextReconcileAt: number;
  lastReconciledAt: number | null;
  lastError: string | null;
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
  removalObservations: number;
}

export async function initSpacesStorage(
  db: Database,
  projection: ContrailConfig,
): Promise<void> {
  await initIsolatedProjection(db, projection);
  const bigint = db.dialect?.bigintType ?? "INTEGER";
  const statements = [
    `CREATE TABLE IF NOT EXISTS spaces_watches (
      space_uri TEXT PRIMARY KEY,
      authority_did TEXT NOT NULL,
      space_type TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      registration_expires_at TEXT,
      next_reconcile_at ${bigint} NOT NULL,
      last_reconciled_at ${bigint},
      last_error TEXT,
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
      removal_observations INTEGER NOT NULL DEFAULT 0,
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
      row.registration_expires_at === null ? null : String(row.registration_expires_at),
    nextReconcileAt: Number(row.next_reconcile_at),
    lastReconciledAt:
      row.last_reconciled_at === null ? null : Number(row.last_reconciled_at),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

export async function getSpaceWatch(
  db: Database,
  spaceUri: string,
): Promise<SpaceWatch | null> {
  const row = await db.prepare(
    `SELECT space_uri, authority_did, space_type, generation, status,
            registration_expires_at, next_reconcile_at, last_reconciled_at, last_error
     FROM spaces_watches WHERE space_uri = ?`,
  ).bind(spaceUri).first<Record<string, unknown>>();
  return row ? rowToWatch(row) : null;
}

export async function ensureSpaceWatch(
  db: Database,
  input: { spaceUri: string; reconcileAt?: number },
): Promise<SpaceWatch> {
  const parsed = parseSpaceUri(input.spaceUri);
  const now = Date.now();
  await db.prepare(
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
  ).bind(
    input.spaceUri,
    parsed.authorityDid,
    parsed.type,
    input.reconcileAt ?? now,
    now,
    now,
  ).run();
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
  await db.prepare(
    `UPDATE spaces_watches SET
       authority_did = ?, space_type = ?, generation = ?, status = 'active',
       registration_expires_at = NULL, next_reconcile_at = ?,
       last_reconciled_at = NULL, last_error = NULL, updated_at = ?
     WHERE space_uri = ? AND generation = ? AND status = 'hidden'`,
  ).bind(
    parsed.authorityDid,
    parsed.type,
    nextGeneration,
    now,
    now,
    spaceUri,
    hidden.generation,
  ).run();
  const watch = await getSpaceWatch(db, spaceUri);
  if (!watch || watch.status !== "active" || watch.generation !== nextGeneration) {
    throw new Error("Concurrent Space rediscovery changed the watch generation");
  }
  return watch;
}

export async function listDueWatches(
  db: Database,
  now: number,
  limit: number,
): Promise<SpaceWatch[]> {
  const rows = await db.prepare(
    `SELECT space_uri, authority_did, space_type, generation, status,
            registration_expires_at, next_reconcile_at, last_reconciled_at, last_error
     FROM spaces_watches
     WHERE status = 'active' AND next_reconcile_at <= ?
     ORDER BY next_reconcile_at, space_uri LIMIT ?`,
  ).bind(now, limit).all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToWatch);
}

export async function updateWatch(
  db: Database,
  spaceUri: string,
  input: {
    registrationExpiresAt?: string | null;
    nextReconcileAt?: number;
    reconciledAt?: number;
    error?: string | null;
    status?: WatchStatus;
    /** Ignore stale work from a prior deletion/rediscovery generation. */
    expectedGeneration?: number;
  },
): Promise<void> {
  const current = await getSpaceWatch(db, spaceUri);
  if (!current) return;
  const generationGuard = input.expectedGeneration === undefined
    ? ""
    : " AND generation = ?";
  const statement = db.prepare(
    `UPDATE spaces_watches SET
      registration_expires_at = ?, next_reconcile_at = ?,
      last_reconciled_at = ?, last_error = ?, status = ?, updated_at = ?
     WHERE space_uri = ?${generationGuard}`,
  ).bind(
    input.registrationExpiresAt === undefined
      ? current.registrationExpiresAt
      : input.registrationExpiresAt,
    input.nextReconcileAt ?? current.nextReconcileAt,
    input.reconciledAt === undefined ? current.lastReconciledAt : input.reconciledAt,
    input.error === undefined ? current.lastError : input.error,
    input.status ?? current.status,
    Date.now(),
    spaceUri,
    ...(input.expectedGeneration === undefined ? [] : [input.expectedGeneration]),
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
  await db.prepare(
    `INSERT INTO spaces_credentials
       (space_uri, space_generation, viewer_did, encrypted_value, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation) DO UPDATE SET
       viewer_did = excluded.viewer_did,
       encrypted_value = excluded.encrypted_value,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).bind(
    input.spaceUri,
    input.generation,
    input.viewerDid,
    JSON.stringify(encrypted),
    input.credential.expiresAt,
    Date.now(),
  ).run();
}

export async function loadCredential(
  db: Database,
  input: { spaceUri: string; generation: number; encryptionKey: string },
): Promise<{ viewerDid: string; credential: StoredSpaceCredential } | null> {
  const row = await db.prepare(
    `SELECT viewer_did, encrypted_value, expires_at FROM spaces_credentials
     WHERE space_uri = ? AND space_generation = ?`,
  ).bind(input.spaceUri, input.generation).first<{
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
  return { viewerDid: row.viewer_did, credential };
}

export async function saveAccessLease(
  db: Database,
  input: {
    userDid: string;
    spaceUri: string;
    generation: number;
    expiresAt: number;
    evidence?: string;
  },
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO spaces_access_leases
       (user_did, space_uri, space_generation, expires_at, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_did, space_uri, space_generation) DO UPDATE SET
       expires_at = excluded.expires_at, evidence = excluded.evidence,
       created_at = excluded.created_at`,
  ).bind(
    input.userDid,
    input.spaceUri,
    input.generation,
    input.expiresAt,
    input.evidence ?? "delegation",
    now,
  ).run();
}

export async function hasAccessLease(
  db: Database,
  input: { userDid: string; spaceUri: string; generation: number; now?: number },
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM spaces_access_leases
     WHERE user_did = ? AND space_uri = ? AND space_generation = ? AND expires_at > ?`,
  ).bind(
    input.userDid,
    input.spaceUri,
    input.generation,
    input.now ?? Date.now(),
  ).first<{ ok: number }>();
  return row?.ok === 1;
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
    removalObservations: Number(row.removal_observations),
  };
}

export async function listRepoStates(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
): Promise<SpaceRepoState[]> {
  const rows = await db.prepare(
    `SELECT space_uri, space_generation, repo_did, pds_url,
            visible_writer_generation, rev, lt_hash, commit_hash, removal_observations
     FROM spaces_repo_state WHERE space_uri = ? AND space_generation = ?`,
  ).bind(watch.spaceUri, watch.generation).all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToRepo);
}

export async function getRepoState(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  repoDid: string,
): Promise<SpaceRepoState | null> {
  const row = await db.prepare(
    `SELECT space_uri, space_generation, repo_did, pds_url,
            visible_writer_generation, rev, lt_hash, commit_hash, removal_observations
     FROM spaces_repo_state
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
  ).bind(watch.spaceUri, watch.generation, repoDid).first<Record<string, unknown>>();
  return row ? rowToRepo(row) : null;
}

/** Commit checkpoint metadata after projection statements in the same batch. */
export function saveRepoStateStatement(
  db: Database,
  state: Omit<SpaceRepoState, "removalObservations"> & { removalObservations?: number },
): Statement {
  return db.prepare(
    `INSERT INTO spaces_repo_state
       (space_uri, space_generation, repo_did, pds_url,
        visible_writer_generation, rev, lt_hash, commit_hash,
        removal_observations, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation, repo_did) DO UPDATE SET
       pds_url = excluded.pds_url,
       visible_writer_generation = excluded.visible_writer_generation,
       rev = excluded.rev, lt_hash = excluded.lt_hash,
       commit_hash = excluded.commit_hash,
       removal_observations = excluded.removal_observations,
       updated_at = excluded.updated_at`,
  ).bind(
    state.spaceUri,
    state.spaceGeneration,
    state.repoDid,
    state.pdsUrl,
    state.visibleWriterGeneration,
    state.rev,
    state.ltHash,
    state.commitHash,
    state.removalObservations ?? 0,
    Date.now(),
  );
}

export async function noteRepoOmissions(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  present: ReadonlySet<string>,
): Promise<SpaceRepoState[]> {
  const states = await listRepoStates(db, watch);
  const confirmed: SpaceRepoState[] = [];
  for (const state of states) {
    if (present.has(state.repoDid)) {
      if (state.removalObservations !== 0) {
        await db.prepare(
          `UPDATE spaces_repo_state SET removal_observations = 0
           WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
        ).bind(watch.spaceUri, watch.generation, state.repoDid).run();
      }
      continue;
    }
    const observations = state.removalObservations + 1;
    await db.prepare(
      `UPDATE spaces_repo_state SET removal_observations = ?, updated_at = ?
       WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    ).bind(observations, Date.now(), watch.spaceUri, watch.generation, state.repoDid).run();
    if (observations >= 2) confirmed.push({ ...state, removalObservations: observations });
  }
  return confirmed;
}

export async function deleteRepoState(
  db: Database,
  watch: Pick<SpaceWatch, "spaceUri" | "generation">,
  repoDid: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM spaces_repo_state
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
  ).bind(watch.spaceUri, watch.generation, repoDid).run();
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
  await db.prepare(
    `INSERT INTO spaces_sync_leases
       (space_uri, space_generation, repo_did, owner, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(space_uri, space_generation, repo_did) DO UPDATE SET
       owner = excluded.owner, expires_at = excluded.expires_at
     WHERE spaces_sync_leases.expires_at <= ? OR spaces_sync_leases.owner = ?`,
  ).bind(
    input.spaceUri,
    input.generation,
    input.repoDid,
    input.owner,
    expires,
    now,
    input.owner,
  ).run();
  const row = await db.prepare(
    `SELECT owner, expires_at FROM spaces_sync_leases
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
  ).bind(input.spaceUri, input.generation, input.repoDid).first<{
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
  await db.prepare(
    `UPDATE spaces_sync_leases SET expires_at = ?
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?
       AND owner = ? AND expires_at > ?`,
  ).bind(
    expires,
    input.spaceUri,
    input.generation,
    input.repoDid,
    input.owner,
    now,
  ).run();
  const row = await db.prepare(
    `SELECT owner, expires_at FROM spaces_sync_leases
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
  ).bind(input.spaceUri, input.generation, input.repoDid).first<{
    owner: string;
    expires_at: number;
  }>();
  return row?.owner === input.owner && Number(row.expires_at) === expires;
}

export async function releaseSyncLease(
  db: Database,
  input: { spaceUri: string; generation: number; repoDid: string; owner: string },
): Promise<void> {
  await db.prepare(
    `DELETE FROM spaces_sync_leases
     WHERE space_uri = ? AND space_generation = ? AND repo_did = ? AND owner = ?`,
  ).bind(input.spaceUri, input.generation, input.repoDid, input.owner).run();
}

/** Immediately deny all reads and invalidate credentials/work for a deleted Space. */
export async function hideDeletedSpace(
  db: Database,
  watch: SpaceWatch,
): Promise<void> {
  const nextGeneration = watch.generation + 1;
  await db.batch([
    db.prepare(
      `UPDATE spaces_watches SET status = 'hidden', generation = ?,
       registration_expires_at = NULL, last_error = NULL, updated_at = ?
       WHERE space_uri = ? AND generation = ?`,
    ).bind(nextGeneration, Date.now(), watch.spaceUri, watch.generation),
    db.prepare(
      `DELETE FROM isolated_projection_partitions WHERE scope_key = ?`,
    ).bind(spaceProjectionKey(watch.spaceUri, watch.generation)),
    db.prepare(
      `DELETE FROM spaces_access_leases
       WHERE space_uri = ? AND space_generation = ?`,
    ).bind(watch.spaceUri, watch.generation),
    db.prepare(
      `DELETE FROM spaces_credentials
       WHERE space_uri = ? AND space_generation = ?`,
    ).bind(watch.spaceUri, watch.generation),
    db.prepare(
      `DELETE FROM spaces_sync_leases
       WHERE space_uri = ? AND space_generation = ?`,
    ).bind(watch.spaceUri, watch.generation),
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
  await db.prepare(
    `DELETE FROM spaces_repo_state
     WHERE space_uri = ? AND space_generation = ?`,
  ).bind(watch.spaceUri, watch.generation).run();
}
