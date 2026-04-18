import type { ContrailConfig, Database } from "../types";
import type { SqlDialect } from "../dialect";
import { getDialect } from "../dialect";
import {
  buildCollectionTables,
  buildDynamicIndexes,
  buildFtsTables,
  buildCountColumns,
} from "../db/schema";

/** Spaces metadata tables — spaces, members, invites. No per-collection tables. */
export function buildSpacesBaseSchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS spaces (
      uri TEXT PRIMARY KEY,
      owner_did TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      service_did TEXT NOT NULL,
      member_list_ref TEXT,
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
      perms TEXT NOT NULL,
      added_at ${dialect.bigintType} NOT NULL,
      added_by TEXT,
      PRIMARY KEY (space_uri, did)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_members_did ON spaces_members(did)`,

    `CREATE TABLE IF NOT EXISTS spaces_invites (
      token_hash TEXT PRIMARY KEY,
      space_uri TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'join',
      perms TEXT NOT NULL,
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

/** Full spaces schema (base + per-collection tables + indexes). For callers
 *  that need a single array of statements. Note: this does NOT include FTS
 *  virtual tables or ALTER TABLE count columns — those must be applied with
 *  try/catch fallbacks and are handled by `initSchema`. */
export function buildSpacesSchema(db: Database, config?: ContrailConfig): string[] {
  const dialect = getDialect(db);
  const base = buildSpacesBaseSchema(dialect);
  if (!config) return base;
  return [
    ...base,
    ...buildCollectionTables(config, dialect, { forSpaces: true }),
    ...buildDynamicIndexes(config, dialect, { forSpaces: true }),
  ];
}

export async function initSpacesSchema(db: Database, config?: ContrailConfig): Promise<void> {
  const dialect = getDialect(db);
  const stmts = buildSpacesSchema(db, config);
  await db.batch(stmts.map((s) => db.prepare(s)));
  if (!config) return;
  for (const stmt of buildFtsTables(config, dialect, { forSpaces: true })) {
    try { await db.prepare(stmt).run(); } catch { /* ignore */ }
  }
  for (const stmt of buildCountColumns(config, { forSpaces: true })) {
    try { await db.prepare(stmt).run(); } catch { /* ignore */ }
  }
}
