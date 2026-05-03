import type { Database, RecordRow } from "../types";

export interface FormattedRecord {
  uri: string;
  cid: string | null;
  value: unknown;
  did: string;
  collection: string;
  rkey: string;
  time_us: number;
  [key: string]: unknown;
}

export function formatRecord(row: RecordRow): FormattedRecord {
  let value: unknown = null;
  if (row.record) {
    try {
      value = JSON.parse(row.record);
    } catch {
      value = row.record;
    }
  }
  return {
    uri: row.uri,
    cid: row.cid,
    value,
    did: row.did,
    collection: row.collection,
    rkey: row.rkey,
    time_us: row.time_us,
    ...(row.space ? { space: row.space } : {}),
  };
}

export function parseIntParam(
  value: string | null | undefined,
  defaultValue?: number
): number | undefined {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function fieldToParam(field: string): string {
  return field.replace(/\.(\w)/g, (_, c) => c.toUpperCase());
}

const BATCH_SIZE = 50;

export async function batchedInQuery<T>(
  db: Database,
  sql: string,
  prefixBindings: (string | number)[],
  inValues: string[]
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < inValues.length; i += BATCH_SIZE) {
    const chunk = inValues.slice(i, i + BATCH_SIZE);
    const query = sql.replace("__IN__", chunk.map(() => "?").join(","));
    const rows = await db
      .prepare(query)
      .bind(...prefixBindings, ...chunk)
      .all<T>();
    results.push(...(rows.results ?? []));
  }
  return results;
}
