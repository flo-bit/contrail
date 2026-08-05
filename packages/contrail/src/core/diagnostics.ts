import type { Database, Statement } from "./types";

export const INGEST_DIAGNOSTIC_CATEGORIES = [
  "unknown_collection",
  "invalid_json",
  "lexicon_validation",
  "cid_mismatch",
  "cid_encoding",
  "missing_cid",
  "record_filter",
  "unknown_actor",
  "unknown_subject",
  "superseded",
] as const;

export type IngestDiagnosticCategory =
  (typeof INGEST_DIAGNOSTIC_CATEGORIES)[number];

export interface IngestDiagnostic {
  category: IngestDiagnosticCategory;
  total: number;
  last_seen_at: number | null;
}

export type IngestDiagnosticCounts = Partial<
  Record<IngestDiagnosticCategory, number>
>;

/** Merge one ingest decision batch into a bounded in-memory aggregate. */
export function addIngestDiagnosticCounts(
  target: IngestDiagnosticCounts,
  counts: IngestDiagnosticCounts,
): void {
  for (const category of INGEST_DIAGNOSTIC_CATEGORIES) {
    const total = counts[category] ?? 0;
    if (total > 0) target[category] = (target[category] ?? 0) + total;
  }
}

/** Build one bounded aggregate update for an ingest transaction. */
export function ingestDiagnosticsStatement(
  db: Database,
  counts: IngestDiagnosticCounts,
  nowUs: number = Date.now() * 1000,
): Statement | null {
  const entries = INGEST_DIAGNOSTIC_CATEGORIES.flatMap((category) => {
    const total = counts[category] ?? 0;
    return total > 0 ? [{ category, total }] : [];
  });
  if (entries.length === 0) return null;
  const values = entries.map(() => "(?, ?, ?)").join(", ");
  return db
    .prepare(
      `INSERT INTO ingest_diagnostics (category, total, last_seen_at) VALUES ${values} ON CONFLICT(category) DO UPDATE SET total = ingest_diagnostics.total + excluded.total, last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      ...entries.flatMap(({ category, total }) => [category, total, nowUs]),
    );
}

/** Private, aggregate-only diagnostics. Never includes DIDs, URIs, or records. */
export async function getIngestDiagnostics(
  db: Database,
): Promise<IngestDiagnostic[]> {
  const rows = await db
    .prepare(
      "SELECT category, total, last_seen_at FROM ingest_diagnostics ORDER BY category",
    )
    .all<{
      category: IngestDiagnosticCategory;
      total: number;
      last_seen_at: number;
    }>();
  const byCategory = new Map(
    (rows.results ?? []).map((row) => [row.category, row]),
  );
  return INGEST_DIAGNOSTIC_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return {
      category,
      total: row?.total ?? 0,
      last_seen_at: row?.last_seen_at ?? null,
    };
  });
}
