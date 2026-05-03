/** Authority-side DDL: `spaces`, `spaces_members`, `spaces_invites`. */

import type { Database, SqlDialect } from "@atmo-dev/contrail-base";
import { getDialect } from "@atmo-dev/contrail-base";

export function buildAuthoritySchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS spaces (
      uri TEXT PRIMARY KEY,
      owner_did TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      service_did TEXT NOT NULL,
      app_policy_ref TEXT,
      app_policy ${dialect.recordColumnType},
      created_at ${dialect.bigintType} NOT NULL,
      deleted_at ${dialect.bigintType}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_did)`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_type ON spaces(type)`,

    `CREATE TABLE IF NOT EXISTS spaces_members (
      space_uri TEXT NOT NULL,
      did TEXT NOT NULL,
      added_at ${dialect.bigintType} NOT NULL,
      added_by TEXT,
      PRIMARY KEY (space_uri, did)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_members_did ON spaces_members(did)`,

    `CREATE TABLE IF NOT EXISTS spaces_invites (
      token_hash TEXT PRIMARY KEY,
      space_uri TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'join',
      expires_at ${dialect.bigintType},
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at ${dialect.bigintType} NOT NULL,
      revoked_at ${dialect.bigintType},
      note TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_invites_space ON spaces_invites(space_uri, created_at DESC)`,
  ];
}

/** SchemaModule-shaped function suitable for `initSchema({ extraSchemas: [...] })`. */
export async function applyAuthoritySchema(db: Database): Promise<void> {
  const dialect = getDialect(db);
  const stmts = buildAuthoritySchema(dialect);
  await db.batch(stmts.map((s) => db.prepare(s)));
}
