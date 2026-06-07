import type { Database } from "../types";

/**
 * Generic single-row-per-key store backed by `_contrail_meta(key, value)`.
 * Backs the schema-fingerprint gate (schema.ts) and the optimize cadence
 * timestamp (the ingest tick).
 *
 * Reads are tolerant: if the table doesn't exist yet — the first `initSchema`
 * before any DDL has run — the read resolves to null rather than throwing, so a
 * caller treats "no table" the same as "no value". Any transient read error
 * degrades the same way (callers fall back to doing the work), which is safe
 * because the only callers gate idempotent work on the result.
 */
export async function getMeta(db: Database, key: string): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setMeta(
  db: Database,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(key, value)
    .run();
}

export async function getMetaNumber(
  db: Database,
  key: string
): Promise<number | null> {
  const v = await getMeta(db, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
