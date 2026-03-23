import type { RelationConfig, ReferenceConfig, RecordRow, Database } from "../types";
import { getNestedValue, getRelationField, recordsTableName } from "../types";
import { batchedInQuery, formatRecord } from "./helpers";

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
        relHydrates[relName] = limit;
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
  records: RecordRow[]
): Promise<HydrateResult> {
  if (Object.keys(requested).length === 0 || records.length === 0) return {};

  const grouped: Record<string, Record<string, Record<string, any[]>>> = {};

  for (const [relName, hydrateLimit] of Object.entries(requested)) {
    const rel = relations[relName];
    const field = getRelationField(rel);
    const matchMode = rel.match ?? "uri";
    const table = recordsTableName(rel.collection);

    const matchValues = matchMode === "did"
      ? [...new Set(records.map((r) => r.did))]
      : records.map((r) => r.uri);

    if (matchValues.length === 0) continue;

    const groupCount = rel.groupBy ? 10 : 1;
    const maxRows = matchValues.length * hydrateLimit * groupCount;
    const relatedRows = await batchedInQuery<Omit<RecordRow, "collection">>(
      db,
      `SELECT uri, did, rkey, record, time_us FROM ${table}
       WHERE json_extract(record, '$.${field}') IN (__IN__)
       ORDER BY time_us DESC
       LIMIT ${maxRows}`,
      [],
      matchValues
    );

    for (const row of relatedRows) {
      const record = row.record ? JSON.parse(row.record) : null;
      const matchedValue = getNestedValue(record, field);
      if (!matchedValue) continue;

      const parentUris = matchMode === "did"
        ? records.filter((r) => r.did === matchedValue).map((r) => r.uri)
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
          group.push(formatRecord({ ...row, collection: rel.collection }));
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
  records: RecordRow[]
): Promise<ReferenceResult> {
  if (requested.size === 0 || records.length === 0) return {};

  const result: ReferenceResult = {};

  for (const refName of requested) {
    const ref = references[refName];
    if (!ref) continue;

    const table = recordsTableName(ref.collection);

    const targetMap = new Map<string, string[]>();
    for (const r of records) {
      const parsed = r.record ? JSON.parse(r.record) : null;
      const targetValue = parsed ? getNestedValue(parsed, ref.field) : null;
      if (!targetValue) continue;
      if (!targetMap.has(targetValue)) targetMap.set(targetValue, []);
      targetMap.get(targetValue)!.push(r.uri);
    }

    const targetUris = [...targetMap.keys()];
    if (targetUris.length === 0) continue;

    const rows = await batchedInQuery<Omit<RecordRow, "collection">>(
      db,
      `SELECT uri, did, rkey, record, time_us FROM ${table}
       WHERE uri IN (__IN__)`,
      [],
      targetUris
    );

    for (const row of rows) {
      const parentUris = targetMap.get(row.uri) ?? [];
      for (const parentUri of parentUris) {
        if (!result[parentUri]) result[parentUri] = {};
        result[parentUri][refName] = formatRecord({ ...row, collection: ref.collection });
      }
    }
  }

  return result;
}
