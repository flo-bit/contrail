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
  ];
}

export async function initCommunitySchema(db: Database): Promise<void> {
  const dialect = getDialect(db);
  const stmts = buildCommunitySchema(dialect);
  await db.batch(stmts.map((s) => db.prepare(s)));
}
