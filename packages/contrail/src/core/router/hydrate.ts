import type { RelationConfig, ReferenceConfig, RecordRow, Database, ContrailConfig } from "../types";
import { getDialect } from "../dialect";
import {
  getNestedValue,
  getRelationField,
  recordsTableName,
  spacesRecordsTableName,
  nsidForShortName,
} from "../types";
import { batchedInQuery, formatRecord } from "./helpers";

/** Group rows by their origin: public (undefined key) or a specific spaceUri. */
function groupBySource<T extends { space?: string }>(rows: T[]): Map<string | undefined, T[]> {
  const groups = new Map<string | undefined, T[]>();
  for (const r of rows) {
    const key = r.space;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

// --- Hydration: embed related records ---

export function parseHydrateParams(
  params: URLSearchParams,
  relations: Record<string, RelationConfig>,
  references: Record<string, ReferenceConfig>
): { relations: Record<string, number>; references: Set<string> } {
  const relHydrates: Record<string, number> = {};
  const refHydrates = new Set<string>();
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  for (const relName of Object.keys(relations)) {
    const val = params.get(`hydrate${capitalize(relName)}`);
    if (val) {
      const limit = parseInt(val, 10);
      if (!isNaN(limit) && limit > 0) {
        relHydrates[relName] = Math.min(limit, 50);
      }
    }
  }

  for (const refName of Object.keys(references)) {
    const val = params.get(`hydrate${capitalize(refName)}`);
    if (val === "true" || val === "1") {
      refHydrates.add(refName);
    }
  }

  return { relations: relHydrates, references: refHydrates };
}

// Per-relation hydrate result: array for ungrouped, Record<group, array> for grouped
export type HydrateResult = Record<string, Record<string, any[] | Record<string, any[]>>>;

export async function resolveHydrates(
  db: Database,
  relations: Record<string, RelationConfig>,
  requested: Record<string, number>,
  records: RecordRow[],
  config?: ContrailConfig
): Promise<HydrateResult> {
  if (Object.keys(requested).length === 0 || records.length === 0) return {};

  const grouped: Record<string, Record<string, Record<string, any[]>>> = {};

  const sourceGroups = groupBySource(records);

  for (const [relName, hydrateLimit] of Object.entries(requested)) {
    const rel = relations[relName];
    const field = getRelationField(rel);
    const matchMode = rel.match ?? "uri";

    for (const [sourceSpace, sourceRecords] of sourceGroups) {
      const matchValues = matchMode === "did"
        ? [...new Set(sourceRecords.map((r) => r.did))]
        : sourceRecords.map((r) => r.uri);

      if (matchValues.length === 0) continue;

      const groupCount = rel.groupBy ? 10 : 1;
      const maxRows = matchValues.length * hydrateLimit * groupCount;

      const table = sourceSpace
        ? spacesRecordsTableName(rel.collection)
        : recordsTableName(rel.collection);
      const where = sourceSpace
        ? `space_uri = ? AND ${getDialect(db).jsonExtract('record', field)} IN (__IN__)`
        : `${getDialect(db).jsonExtract('record', field)} IN (__IN__)`;
      const prefix = sourceSpace ? [sourceSpace] : [];

      const relatedRows = await batchedInQuery<Omit<RecordRow, "collection">>(
        db,
        `SELECT uri, did, rkey, record, time_us FROM ${table}
         WHERE ${where}
         ORDER BY time_us DESC
         LIMIT ${maxRows}`,
        prefix,
        matchValues
      );

      for (const row of relatedRows) {
        const record = row.record ? JSON.parse(row.record) : null;
        const matchedValue = getNestedValue(record, field);
        if (!matchedValue) continue;

        const parentUris = matchMode === "did"
          ? sourceRecords.filter((r) => r.did === matchedValue).map((r) => r.uri)
          : [matchedValue];

        const groupValue = rel.groupBy
          ? String(getNestedValue(record, rel.groupBy) ?? "other")
          : "_flat";

        for (const parentUri of parentUris) {
          const targetUri = matchMode === "did" ? parentUri : matchedValue;

          if (!grouped[targetUri]) grouped[targetUri] = {};
          if (!grouped[targetUri][relName]) grouped[targetUri][relName] = {};
          if (!grouped[targetUri][relName][groupValue]) grouped[targetUri][relName][groupValue] = [];

          const group = grouped[targetUri][relName][groupValue];
          if (group.length < hydrateLimit) {
            const childNsid = config
              ? nsidForShortName(config, rel.collection) ?? rel.collection
              : rel.collection;
            group.push(
              formatRecord({
                ...(row as any),
                collection: childNsid,
                ...(sourceSpace ? { space: sourceSpace } : {}),
              } as RecordRow)
            );
          }
        }
      }
    }
  }

  const result: HydrateResult = {};
  for (const [uri, rels] of Object.entries(grouped)) {
    result[uri] = {};
    for (const [relName, groups] of Object.entries(rels)) {
      if (relations[relName].groupBy) {
        result[uri][relName] = groups;
      } else {
        result[uri][relName] = groups["_flat"] ?? [];
      }
    }
  }

  return result;
}

// --- References: embed records that our records point at ---

export type ReferenceResult = Record<string, Record<string, any>>;

export async function resolveReferences(
  db: Database,
  references: Record<string, ReferenceConfig>,
  requested: Set<string>,
  records: RecordRow[],
  config?: ContrailConfig
): Promise<ReferenceResult> {
  if (requested.size === 0 || records.length === 0) return {};

  const result: ReferenceResult = {};

  const sourceGroups = groupBySource(records);

  for (const refName of requested) {
    const ref = references[refName];
    if (!ref) continue;

    const refNsid = config
      ? nsidForShortName(config, ref.collection) ?? ref.collection
      : ref.collection;

    for (const [sourceSpace, sourceRecords] of sourceGroups) {
      const targetMap = new Map<string, string[]>();
      for (const r of sourceRecords) {
        const parsed = r.record ? JSON.parse(r.record) : null;
        const targetValue = parsed ? getNestedValue(parsed, ref.field) : null;
        if (!targetValue) continue;
        if (!targetMap.has(targetValue)) targetMap.set(targetValue, []);
        targetMap.get(targetValue)!.push(r.uri);
      }

      const targetUris = [...targetMap.keys()];
      if (targetUris.length === 0) continue;

      const table = sourceSpace
        ? spacesRecordsTableName(ref.collection)
        : recordsTableName(ref.collection);
      const where = sourceSpace ? `space_uri = ? AND uri IN (__IN__)` : `uri IN (__IN__)`;
      const prefix = sourceSpace ? [sourceSpace] : [];

      const rows = await batchedInQuery<Omit<RecordRow, "collection">>(
        db,
        `SELECT uri, did, rkey, record, time_us FROM ${table} WHERE ${where}`,
        prefix,
        targetUris
      );

      for (const row of rows) {
        const parentUris = targetMap.get(row.uri) ?? [];
        for (const parentUri of parentUris) {
          if (!result[parentUri]) result[parentUri] = {};
          result[parentUri][refName] = formatRecord({
            ...(row as any),
            collection: refNsid,
            ...(sourceSpace ? { space: sourceSpace } : {}),
          } as RecordRow);
        }
      }
    }
  }

  return result;
}
