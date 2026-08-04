import type { CollectionConfig } from "./types";
import { getNestedValue } from "./types";

/**
 * Resolve which fields are searchable for a collection.
 * Returns null if search is disabled or no fields found.
 */
export function getSearchableFields(
  collection: string,
  colConfig: CollectionConfig
): string[] | null {
  if (!Array.isArray(colConfig.searchable)) return null;
  return colConfig.searchable.length > 0 ? colConfig.searchable : null;
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
