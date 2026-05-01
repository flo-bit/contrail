import type { Database } from "../types";
import type {
  AccessLevel,
  AccessLevelRow,
  CommunityInviteRow,
  CommunityMode,
  CommunityRow,
  CreateCommunityInviteInput,
  CreateProvisionAttemptInput,
  ProvisionAttemptRow,
  ProvisionStatus,
} from "./types";

function toNum(v: unknown): number {
  return typeof v === "string" ? Number(v) : (v as number);
}

function mapCommunityRow(row: any): CommunityRow {
  return {
    did: row.did,
    mode: row.mode as CommunityMode,
    pdsEndpoint: row.pds_endpoint ?? null,
    identifier: row.identifier ?? null,
    createdBy: row.created_by,
    createdAt: toNum(row.created_at),
    deletedAt: row.deleted_at == null ? null : toNum(row.deleted_at),
  };
}

function mapAccessRow(row: any): AccessLevelRow {
  const isSpace = row.subject_kind === "space";
  return {
    spaceUri: row.space_uri,
    subjectDid: isSpace ? null : row.subject,
    subjectSpaceUri: isSpace ? row.subject : null,
    accessLevel: row.access_level as AccessLevel,
    grantedBy: row.granted_by,
    grantedAt: toNum(row.granted_at),
  };
}

export interface CreateAdoptedCommunityInput {
  did: string;
  pdsEndpoint: string;
  appPasswordEncrypted: string; // base64 envelope
  identifier: string;
  createdBy: string;
}

export interface CreateMintedCommunityInput {
  did: string;
  signingKeyEncrypted: string; // base64 envelope
  rotationKeyEncrypted: string; // base64 envelope
  createdBy: string;
}

export interface GrantInput {
  spaceUri: string;
  subjectDid?: string;
  subjectSpaceUri?: string;
  accessLevel: AccessLevel;
  grantedBy: string;
}

export class CommunityAdapter {
  constructor(private readonly db: Database) {}

  // ---- Communities -------------------------------------------------------

  async createAdoptedCommunity(input: CreateAdoptedCommunityInput): Promise<CommunityRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO communities (did, mode, pds_endpoint, app_password_encrypted, identifier, created_by, created_at)
         VALUES (?, 'adopt', ?, ?, ?, ?, ?)`
      )
      .bind(
        input.did,
        input.pdsEndpoint,
        input.appPasswordEncrypted,
        input.identifier,
        input.createdBy,
        now
      )
      .run();
    return {
      did: input.did,
      mode: "adopt",
      pdsEndpoint: input.pdsEndpoint,
      identifier: input.identifier,
      createdBy: input.createdBy,
      createdAt: now,
      deletedAt: null,
    };
  }

  async createMintedCommunity(input: CreateMintedCommunityInput): Promise<CommunityRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO communities (did, mode, signing_key_encrypted, rotation_key_encrypted, created_by, created_at)
         VALUES (?, 'mint', ?, ?, ?, ?)`
      )
      .bind(
        input.did,
        input.signingKeyEncrypted,
        input.rotationKeyEncrypted,
        input.createdBy,
        now
      )
      .run();
    return {
      did: input.did,
      mode: "mint",
      pdsEndpoint: null,
      identifier: null,
      createdBy: input.createdBy,
      createdAt: now,
      deletedAt: null,
    };
  }

  async getCommunity(did: string): Promise<CommunityRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM communities WHERE did = ? AND deleted_at IS NULL`)
      .bind(did)
      .first<any>();
    return row ? mapCommunityRow(row) : null;
  }

  /** Look up the raw encrypted credential strings for the community. */
  async getRawCredentials(did: string): Promise<{
    pdsEndpoint: string | null;
    appPasswordEncrypted: string | null;
    signingKeyEncrypted: string | null;
    rotationKeyEncrypted: string | null;
    identifier: string | null;
    mode: CommunityMode;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT mode, pds_endpoint, app_password_encrypted, signing_key_encrypted,
                rotation_key_encrypted, identifier
         FROM communities WHERE did = ? AND deleted_at IS NULL`
      )
      .bind(did)
      .first<any>();
    if (!row) return null;
    return {
      mode: row.mode as CommunityMode,
      pdsEndpoint: row.pds_endpoint ?? null,
      appPasswordEncrypted: row.app_password_encrypted ?? null,
      signingKeyEncrypted: row.signing_key_encrypted ?? null,
      rotationKeyEncrypted: row.rotation_key_encrypted ?? null,
      identifier: row.identifier ?? null,
    };
  }

  async updateAdoptedCredentials(input: {
    did: string;
    pdsEndpoint: string;
    appPasswordEncrypted: string;
    identifier: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE communities
         SET pds_endpoint = ?, app_password_encrypted = ?, identifier = ?
         WHERE did = ? AND mode = 'adopt'`
      )
      .bind(input.pdsEndpoint, input.appPasswordEncrypted, input.identifier, input.did)
      .run();
  }

  /** Direct access-level rows held by the given DID subject. Used as the seed
   *  set for reverse-graph traversal. */
  async listAccessRowsForSubject(subjectDid: string): Promise<AccessLevelRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM community_access_levels
         WHERE subject_kind = 'did' AND subject = ?`
      )
      .bind(subjectDid)
      .all<any>();
    return results.map(mapAccessRow);
  }

  /** Communities owning any of the given space URIs. */
  async listCommunitiesOwningSpaces(spaceUris: string[]): Promise<CommunityRow[]> {
    if (spaceUris.length === 0) return [];
    const placeholders = spaceUris.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT c.* FROM communities c
         JOIN spaces s ON s.owner_did = c.did AND s.deleted_at IS NULL
         WHERE c.deleted_at IS NULL AND s.uri IN (${placeholders})
         ORDER BY c.created_at DESC`
      )
      .bind(...spaceUris)
      .all<any>();
    return results.map(mapCommunityRow);
  }

  async softDeleteCommunity(did: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(`UPDATE communities SET deleted_at = ? WHERE did = ?`)
      .bind(now, did)
      .run();
    // Cascade soft-delete all spaces owned by the community.
    await this.db
      .prepare(
        `UPDATE spaces SET deleted_at = ? WHERE owner_did = ? AND deleted_at IS NULL`
      )
      .bind(now, did)
      .run();
  }

  // ---- Access levels -----------------------------------------------------

  async grant(input: GrantInput): Promise<void> {
    if ((input.subjectDid ? 1 : 0) + (input.subjectSpaceUri ? 1 : 0) !== 1) {
      throw new Error("grant requires exactly one of subjectDid or subjectSpaceUri");
    }
    const kind = input.subjectDid ? "did" : "space";
    const subject = (input.subjectDid ?? input.subjectSpaceUri)!;
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO community_access_levels (space_uri, subject, subject_kind, access_level, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (space_uri, subject) DO UPDATE SET
           access_level = excluded.access_level,
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at`
      )
      .bind(input.spaceUri, subject, kind, input.accessLevel, input.grantedBy, now)
      .run();
  }

  async revoke(input: {
    spaceUri: string;
    subjectDid?: string;
    subjectSpaceUri?: string;
  }): Promise<void> {
    if ((input.subjectDid ? 1 : 0) + (input.subjectSpaceUri ? 1 : 0) !== 1) {
      throw new Error("revoke requires exactly one of subjectDid or subjectSpaceUri");
    }
    const subject = (input.subjectDid ?? input.subjectSpaceUri)!;
    await this.db
      .prepare(
        `DELETE FROM community_access_levels WHERE space_uri = ? AND subject = ?`
      )
      .bind(input.spaceUri, subject)
      .run();
  }

  async getAccessRow(
    spaceUri: string,
    subject: string
  ): Promise<AccessLevelRow | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM community_access_levels WHERE space_uri = ? AND subject = ?`
      )
      .bind(spaceUri, subject)
      .first<any>();
    return row ? mapAccessRow(row) : null;
  }

  async listAccessRows(spaceUri: string): Promise<AccessLevelRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM community_access_levels WHERE space_uri = ? ORDER BY granted_at ASC`
      )
      .bind(spaceUri)
      .all<any>();
    return results.map(mapAccessRow);
  }

  /** Spaces that reference `subjectSpaceUri` as a member — used for reverse-graph reconciliation. */
  async listSpacesDelegatingTo(subjectSpaceUri: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT space_uri FROM community_access_levels
         WHERE subject_kind = 'space' AND subject = ?`
      )
      .bind(subjectSpaceUri)
      .all<any>();
    return results.map((r: any) => r.space_uri);
  }

  async deleteAllAccessForSpace(spaceUri: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM community_access_levels WHERE space_uri = ?`)
      .bind(spaceUri)
      .run();
  }

  // ---- Invites -----------------------------------------------------------

  async createInvite(input: CreateCommunityInviteInput): Promise<CommunityInviteRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO community_invites
           (token_hash, space_uri, access_level, created_by, created_at, expires_at, max_uses, used_count, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .bind(
        input.tokenHash,
        input.spaceUri,
        input.accessLevel,
        input.createdBy,
        now,
        input.expiresAt,
        input.maxUses,
        input.note
      )
      .run();
    return {
      tokenHash: input.tokenHash,
      spaceUri: input.spaceUri,
      accessLevel: input.accessLevel,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      usedCount: 0,
      revokedAt: null,
      note: input.note,
    };
  }

  async getInvite(tokenHash: string): Promise<CommunityInviteRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM community_invites WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<any>();
    return row ? mapCommunityInviteRow(row) : null;
  }

  async listInvites(
    spaceUri: string,
    options: { includeRevoked?: boolean } = {}
  ): Promise<CommunityInviteRow[]> {
    const sql = options.includeRevoked
      ? `SELECT * FROM community_invites WHERE space_uri = ? ORDER BY created_at DESC`
      : `SELECT * FROM community_invites WHERE space_uri = ? AND revoked_at IS NULL ORDER BY created_at DESC`;
    const { results } = await this.db.prepare(sql).bind(spaceUri).all<any>();
    return results.map(mapCommunityInviteRow);
  }

  async revokeInvite(tokenHash: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE community_invites SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`
      )
      .bind(Date.now(), tokenHash)
      .run();
    const changes = (res as any)?.changes ?? (res as any)?.meta?.changes ?? 0;
    return Number(changes) > 0;
  }

  /** Atomically consume one "use" from an invite. Returns the updated row if
   *  the invite is currently usable, null otherwise (expired, revoked,
   *  exhausted, or missing). The router calls this, then issues a grant if
   *  the return is non-null. */
  async redeemInvite(tokenHash: string, now: number): Promise<CommunityInviteRow | null> {
    const res = await this.db
      .prepare(
        `UPDATE community_invites
         SET used_count = used_count + 1
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR used_count < max_uses)`
      )
      .bind(tokenHash, now)
      .run();
    const changes = (res as any)?.changes ?? (res as any)?.meta?.changes ?? 0;
    if (Number(changes) === 0) return null;

    const row = await this.db
      .prepare(`SELECT * FROM community_invites WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<any>();
    return row ? mapCommunityInviteRow(row) : null;
  }

  // ---- Provision attempts ------------------------------------------------

  async createProvisionAttempt(input: CreateProvisionAttemptInput): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO provision_attempts (
          attempt_id, did, status, pds_endpoint, handle, email, invite_code,
          encrypted_signing_key, encrypted_rotation_key,
          created_at, updated_at
        ) VALUES (?, ?, 'keys_generated', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.attemptId,
        input.did,
        input.pdsEndpoint,
        input.handle,
        input.email,
        input.inviteCode ?? null,
        input.encryptedSigningKey,
        input.encryptedRotationKey,
        now,
        now
      )
      .run();
  }

  async getProvisionAttempt(attemptId: string): Promise<ProvisionAttemptRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM provision_attempts WHERE attempt_id = ?`)
      .bind(attemptId)
      .first<Record<string, any>>();
    return row ? rowToProvisionAttempt(row) : null;
  }

  async updateProvisionStatus(
    attemptId: string,
    status: ProvisionStatus,
    opts: { lastError?: string; encryptedPassword?: string } = {}
  ): Promise<void> {
    const now = Date.now();
    const stampCol = ({
      genesis_submitted: "genesis_submitted_at",
      account_created: "account_created_at",
      did_doc_updated: "did_doc_updated_at",
      activated: "activated_at",
    } as Record<string, string | undefined>)[status];

    const sets: string[] = [`status = ?`, `updated_at = ?`];
    const args: any[] = [status, now];
    if (stampCol) {
      sets.push(`${stampCol} = ?`);
      args.push(now);
    }
    if (opts.lastError !== undefined) {
      sets.push(`last_error = ?`);
      args.push(opts.lastError);
    }
    if (opts.encryptedPassword !== undefined) {
      sets.push(`encrypted_password = ?`);
      args.push(opts.encryptedPassword);
    }
    args.push(attemptId);

    await this.db
      .prepare(`UPDATE provision_attempts SET ${sets.join(", ")} WHERE attempt_id = ?`)
      .bind(...args)
      .run();
  }

  async listProvisionAttemptsByStatus(
    status: ProvisionStatus,
    olderThanMs: number = 0
  ): Promise<ProvisionAttemptRow[]> {
    const cutoff = Date.now() - olderThanMs;
    const rows = await this.db
      .prepare(
        `SELECT * FROM provision_attempts WHERE status = ? AND updated_at <= ? ORDER BY updated_at ASC`
      )
      .bind(status, cutoff)
      .all<Record<string, any>>();
    return rows.results.map(rowToProvisionAttempt);
  }

  // ---- Community sessions cache -----------------------------------------

  async getSession(communityDid: string): Promise<{
    accessJwt: string;
    refreshJwt: string;
    accessExp: number;
  } | null> {
    const r = await this.db
      .prepare(
        `SELECT access_jwt, refresh_jwt, access_exp FROM community_sessions WHERE community_did = ?`
      )
      .bind(communityDid)
      .first<{ access_jwt: string; refresh_jwt: string; access_exp: number }>();
    if (!r) return null;
    return {
      accessJwt: r.access_jwt,
      refreshJwt: r.refresh_jwt,
      accessExp: Number(r.access_exp),
    };
  }

  async upsertSession(
    communityDid: string,
    s: { accessJwt: string; refreshJwt: string; accessExp: number }
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO community_sessions (community_did, access_jwt, refresh_jwt, access_exp, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (community_did) DO UPDATE SET
           access_jwt = excluded.access_jwt,
           refresh_jwt = excluded.refresh_jwt,
           access_exp = excluded.access_exp,
           updated_at = excluded.updated_at`
      )
      .bind(communityDid, s.accessJwt, s.refreshJwt, s.accessExp, now)
      .run();
  }

  async clearSession(communityDid: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM community_sessions WHERE community_did = ?`)
      .bind(communityDid)
      .run();
  }
}

function rowToProvisionAttempt(r: Record<string, any>): ProvisionAttemptRow {
  return {
    attemptId: r.attempt_id,
    did: r.did,
    status: r.status as ProvisionStatus,
    pdsEndpoint: r.pds_endpoint,
    handle: r.handle,
    email: r.email,
    inviteCode: r.invite_code ?? null,
    encryptedSigningKey: r.encrypted_signing_key ?? null,
    encryptedRotationKey: r.encrypted_rotation_key ?? null,
    encryptedPassword: r.encrypted_password ?? null,
    genesisSubmittedAt: r.genesis_submitted_at == null ? null : Number(r.genesis_submitted_at),
    accountCreatedAt: r.account_created_at == null ? null : Number(r.account_created_at),
    didDocUpdatedAt: r.did_doc_updated_at == null ? null : Number(r.did_doc_updated_at),
    activatedAt: r.activated_at == null ? null : Number(r.activated_at),
    lastError: r.last_error ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapCommunityInviteRow(row: any): CommunityInviteRow {
  return {
    tokenHash: row.token_hash,
    spaceUri: row.space_uri,
    accessLevel: row.access_level as AccessLevel,
    createdBy: row.created_by,
    createdAt: toNum(row.created_at),
    expiresAt: row.expires_at == null ? null : toNum(row.expires_at),
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count ?? 0),
    revokedAt: row.revoked_at == null ? null : toNum(row.revoked_at),
    note: row.note ?? null,
  };
}
