import type { SqlDialect } from "../dialect";

/** DDL for the labels module. Single `labels` table covers record-level
 *  (uri starts with `at://`) and account-level (uri is a bare DID) entries —
 *  the spec collapses both into the same row shape. `labeler_cursors`
 *  mirrors the role of the singleton `cursor` table for jetstream, but
 *  per-labeler. */
export function buildLabelsSchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS labels (
       src TEXT NOT NULL,
       uri TEXT NOT NULL,
       val TEXT NOT NULL,
       cid TEXT,
       neg INTEGER NOT NULL DEFAULT 0,
       exp ${dialect.bigintType},
       cts ${dialect.bigintType} NOT NULL,
       sig BLOB,
       PRIMARY KEY (src, uri, val, cts)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_labels_uri ON labels(uri)`,
    `CREATE INDEX IF NOT EXISTS idx_labels_src_cts ON labels(src, cts DESC)`,
    `CREATE TABLE IF NOT EXISTS labeler_cursors (
       did TEXT PRIMARY KEY,
       cursor ${dialect.bigintType} NOT NULL DEFAULT 0,
       endpoint TEXT,
       resolved_at ${dialect.bigintType}
     )`,
  ];
}
