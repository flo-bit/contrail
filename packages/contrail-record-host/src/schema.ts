/** Record-host DDL: `spaces_blobs`, `record_host_enrollments`, plus the
 *  per-collection `spaces_records_<short>` tables. The latter are config-
 *  driven so they're built via the shared collection-table helper from
 *  contrail-base, not declared here directly. */

import type { Database, ContrailConfig, SqlDialect } from "@atmo-dev/contrail-base";
import { getDialect } from "@atmo-dev/contrail-base";

/** The fixed host tables — independent of the user's collection config. */
export function buildRecordHostBaseSchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS spaces_blobs (
      space_uri  TEXT NOT NULL,
      cid        TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      size       INTEGER NOT NULL,
      author_did TEXT NOT NULL,
      created_at ${dialect.bigintType} NOT NULL,
      PRIMARY KEY (space_uri, cid)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_blobs_author ON spaces_blobs(space_uri, author_did)`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_blobs_created ON spaces_blobs(space_uri, created_at)`,

    // Local cache: spaces this host has agreed to store records for, and
    // which authority signs credentials for each. Filled by the
    // recordHost.enroll endpoint, or auto-populated by the colocated
    // authority's createSpace.
    `CREATE TABLE IF NOT EXISTS record_host_enrollments (
      space_uri TEXT PRIMARY KEY,
      authority_did TEXT NOT NULL,
      enrolled_at ${dialect.bigintType} NOT NULL,
      enrolled_by TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_enrollments_authority ON record_host_enrollments(authority_did)`,
  ];
}

/** SchemaModule-shaped function suitable for `initSchema({ extraSchemas: [...] })`.
 *  Applies the host tables that don't depend on the collection config. The
 *  per-collection `spaces_records_<short>` tables are still applied through
 *  the appview's initSchema path (which knows about collections). */
export async function applyRecordHostSchema(db: Database): Promise<void> {
  const dialect = getDialect(db);
  const stmts = buildRecordHostBaseSchema(dialect);
  await db.batch(stmts.map((s) => db.prepare(s)));
}

// Re-export for callers that want a config-driven schema (per-collection
// tables plus blobs/enrollments). Kept as a convenience for split
// deployments where the host doesn't share a DB with the appview.
export type { ContrailConfig };
