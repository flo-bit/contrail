import type { Database } from "../types";
import { getDialect } from "../dialect";
import type { SqlDialect } from "../dialect";

export function buildCommunitySchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS communities (
      did TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      pds_endpoint TEXT,
      app_password_encrypted TEXT,
      identifier TEXT,
      signing_key_encrypted TEXT,
      rotation_key_encrypted TEXT,
      custody_mode TEXT,
      created_by TEXT NOT NULL,
      created_at ${dialect.bigintType} NOT NULL,
      deleted_at ${dialect.bigintType}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_communities_created_at ON communities(created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS community_access_levels (
      space_uri TEXT NOT NULL,
      subject TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('did', 'space')),
      access_level TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at ${dialect.bigintType} NOT NULL,
      PRIMARY KEY (space_uri, subject)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cal_subject ON community_access_levels(subject)`,
    `CREATE INDEX IF NOT EXISTS idx_cal_subject_space ON community_access_levels(subject)
      WHERE subject_kind = 'space'`,

    `CREATE TABLE IF NOT EXISTS community_invites (
      token_hash TEXT PRIMARY KEY NOT NULL,
      space_uri TEXT NOT NULL,
      access_level TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at ${dialect.bigintType} NOT NULL,
      expires_at ${dialect.bigintType},
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      revoked_at ${dialect.bigintType},
      note TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_community_invites_space ON community_invites(space_uri, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS provision_attempts (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'keys_generated',
        'genesis_submitted',
        'account_created',
        'did_doc_updated',
        'activated',
        'orphaned'
      )),
      pds_endpoint TEXT NOT NULL,
      handle TEXT NOT NULL,
      email TEXT NOT NULL,
      invite_code TEXT,
      encrypted_signing_key TEXT,
      encrypted_rotation_key TEXT,
      encrypted_password TEXT,
      custody_mode TEXT NOT NULL CHECK (custody_mode IN ('managed', 'self_sovereign')) DEFAULT 'managed',
      caller_rotation_did_key TEXT,
      genesis_submitted_at ${dialect.bigintType},
      account_created_at ${dialect.bigintType},
      did_doc_updated_at ${dialect.bigintType},
      activated_at ${dialect.bigintType},
      last_error TEXT,
      created_at ${dialect.bigintType} NOT NULL,
      updated_at ${dialect.bigintType} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_provision_attempts_status ON provision_attempts(status, updated_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_provision_attempts_did ON provision_attempts(did)`,

    `CREATE TABLE IF NOT EXISTS provision_attempts_orphaned_archive (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      pds_endpoint TEXT NOT NULL,
      handle TEXT NOT NULL,
      email TEXT NOT NULL,
      invite_code TEXT,
      custody_mode TEXT,
      last_status TEXT,
      last_error TEXT,
      archived_at ${dialect.bigintType} NOT NULL,
      tombstone_op_cid TEXT,
      notes TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_provision_attempts_orphaned_archive_archived_at ON provision_attempts_orphaned_archive(archived_at DESC)`,

    `CREATE TABLE IF NOT EXISTS community_sessions (
      community_did TEXT PRIMARY KEY NOT NULL,
      access_jwt TEXT NOT NULL,
      refresh_jwt TEXT NOT NULL,
      access_exp ${dialect.bigintType} NOT NULL,
      updated_at ${dialect.bigintType} NOT NULL
    )`,
  ];
}

export async function initCommunitySchema(db: Database): Promise<void> {
  const dialect = getDialect(db);
  const stmts = buildCommunitySchema(dialect);
  await db.batch(stmts.map((s) => db.prepare(s)));
}
