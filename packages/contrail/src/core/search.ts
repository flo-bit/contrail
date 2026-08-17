import type { CollectionConfig } from "./types";
import { getNestedValue } from "./types";

/** ECMAScript whitespace and line-terminator code points trimmed from the
 * combined FTS document. SQLite receives this same explicit set via char(). */
export const FTS_TRIM_CODE_POINTS = [
  0x0009,
  0x000a,
  0x000b,
  0x000c,
  0x000d,
  0x0020,
  0x00a0,
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
] as const;

const FTS_TRIM_CHARACTERS = new Set<number>(FTS_TRIM_CODE_POINTS);

export function trimFtsWhitespace(value: string): string {
  const codePoints = [...value];
  let start = 0;
  let end = codePoints.length;
  while (
    start < end &&
    FTS_TRIM_CHARACTERS.has(codePoints[start]!.codePointAt(0)!)
  ) {
    start++;
  }
  while (
    end > start &&
    FTS_TRIM_CHARACTERS.has(codePoints[end - 1]!.codePointAt(0)!)
  ) {
    end--;
  }
  return codePoints.slice(start, end).join("");
}

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

function sanitizedCollectionName(collection: string): string {
  return collection.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Sanitized FTS virtual-table name for a collection. */
export function ftsTableName(collection: string): string {
  return `fts_${sanitizedCollectionName(collection)}`;
}

/** Ordinary unique URI-to-FTS-rowid mapping table for a collection. */
export function ftsRowTableName(collection: string): string {
  return `${ftsTableName(collection)}_rows`;
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
  const content = trimFtsWhitespace(parts.join(" "));
  return content.length > 0 ? content : null;
}
