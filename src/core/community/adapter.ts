import type { Database } from "../types";
import type { AccessLevel, AccessLevelRow, CommunityMode, CommunityRow } from "./types";

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
}
