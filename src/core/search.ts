import type { CollectionConfig } from "./types";
import { getNestedValue } from "./types";
import { resolvedQueryable } from "./queryable.generated";

/**
 * Resolve which fields are searchable for a collection.
 * Returns null if search is disabled or no fields found.
 */
export function getSearchableFields(
  collection: string,
  colConfig: CollectionConfig
): string[] | null {
  if (colConfig.searchable === false) return null;
  if (Array.isArray(colConfig.searchable)) {
    return colConfig.searchable.length > 0 ? colConfig.searchable : null;
  }
  // Auto-detect: all non-range queryable fields
  const queryable = resolvedQueryable[collection] ?? colConfig.queryable ?? {};
  const fields = Object.entries(queryable)
    .filter(([, f]) => f.type !== "range")
    .map(([name]) => name);
  return fields.length > 0 ? fields : null;
}

/** Sanitized FTS table name for a collection. */
export function ftsTableName(collection: string): string {
  return `fts_${collection.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/** Extract searchable field values from a record and join them into a single string. */
export function buildFtsContent(record: unknown, fields: string[]): string | null {
  const parts: string[] = [];
  for (const field of fields) {
    const value = getNestedValue(record, field);
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
