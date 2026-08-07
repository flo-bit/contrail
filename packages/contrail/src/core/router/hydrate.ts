import type {
  ContrailConfig,
  Database,
  RecordRow,
  ReferenceConfig,
  RelationConfig,
} from "../types";
import { getDialect } from "../dialect";
import {
  getNestedValue,
  getRelationField,
  nsidForShortName,
  recordsTableName,
} from "../types";
import { batchedInQuery, formatRecord } from "./helpers";

export function parseHydrateParams(
  params: URLSearchParams,
  relations: Record<string, RelationConfig>,
  references: Record<string, ReferenceConfig>,
): { relations: Record<string, number>; references: Set<string> } {
  const relationHydrates: Record<string, number> = {};
  const referenceHydrates = new Set<string>();
  const capitalize = (value: string): string =>
    value.charAt(0).toUpperCase() + value.slice(1);

  for (const relationName of Object.keys(relations)) {
    const value = params.get(`hydrate${capitalize(relationName)}`);
    if (!value) continue;
    const limit = Number.parseInt(value, 10);
    if (!Number.isNaN(limit) && limit > 0) {
      relationHydrates[relationName] = Math.min(limit, 50);
    }
  }

  for (const referenceName of Object.keys(references)) {
    const value = params.get(`hydrate${capitalize(referenceName)}`);
    if (value === "true" || value === "1") {
      referenceHydrates.add(referenceName);
    }
  }

  return { relations: relationHydrates, references: referenceHydrates };
}

export type HydrateResult = Record<
  string,
  Record<string, any[] | Record<string, any[]>>
>;

export async function resolveHydrates(
  db: Database,
  relations: Record<string, RelationConfig>,
  requested: Record<string, number>,
  records: RecordRow[],
  config?: ContrailConfig,
): Promise<HydrateResult> {
  if (Object.keys(requested).length === 0 || records.length === 0) return {};

  const grouped: Record<string, Record<string, Record<string, any[]>>> = {};
  for (const [relationName, hydrateLimit] of Object.entries(requested)) {
    const relation = relations[relationName];
    const field = getRelationField(relation);
    const matchMode = relation.match ?? "uri";
    const matchValues =
      matchMode === "did"
        ? [...new Set(records.map((record) => record.did))]
        : records.map((record) => record.uri);
    if (matchValues.length === 0) continue;

    const groupCount = relation.groupBy ? 10 : 1;
    const maxRows = matchValues.length * hydrateLimit * groupCount;
    const relatedRows = await batchedInQuery<
      Omit<RecordRow, "collection">
    >(
      db,
      `SELECT uri, did, rkey, record, time_us
       FROM ${recordsTableName(relation.collection)}
       WHERE ${getDialect(db).jsonExtract("record", field)} IN (__IN__)
       ORDER BY time_us DESC
       LIMIT ${maxRows}`,
      [],
      matchValues,
    );

    for (const row of relatedRows) {
      const value = row.record ? JSON.parse(row.record) : null;
      const matchedValue = getNestedValue(value, field);
      if (!matchedValue) continue;
      const parentUris =
        matchMode === "did"
          ? records
              .filter((record) => record.did === matchedValue)
              .map((record) => record.uri)
          : [matchedValue];
      const rawGroupValue = relation.groupBy
        ? String(getNestedValue(value, relation.groupBy) ?? "other")
        : "_flat";
      const configuredGroup = relation.groups
        ? Object.entries(relation.groups).find(
            ([name, token]) =>
              name === rawGroupValue || token === rawGroupValue,
          )?.[0]
        : undefined;
      const groupValue = relation.groupBy
        ? (configuredGroup ?? (relation.groups ? "other" : rawGroupValue))
        : "_flat";

      for (const parentUri of parentUris) {
        grouped[parentUri] ??= {};
        grouped[parentUri][relationName] ??= {};
        grouped[parentUri][relationName][groupValue] ??= [];
        const group = grouped[parentUri][relationName][groupValue];
        if (group.length >= hydrateLimit) continue;
        group.push(
          formatRecord({
            ...(row as any),
            collection: config
              ? nsidForShortName(config, relation.collection) ??
                relation.collection
              : relation.collection,
          } as RecordRow),
        );
      }
    }
  }

  const result: HydrateResult = {};
  for (const [uri, hydratedRelations] of Object.entries(grouped)) {
    result[uri] = {};
    for (const [relationName, groups] of Object.entries(hydratedRelations)) {
      result[uri][relationName] = relations[relationName].groupBy
        ? groups
        : (groups._flat ?? []);
    }
  }
  return result;
}

export type ReferenceResult = Record<string, Record<string, any>>;

export async function resolveReferences(
  db: Database,
  references: Record<string, ReferenceConfig>,
  requested: Set<string>,
  records: RecordRow[],
  config?: ContrailConfig,
): Promise<ReferenceResult> {
  if (requested.size === 0 || records.length === 0) return {};

  const result: ReferenceResult = {};
  for (const referenceName of requested) {
    const reference = references[referenceName];
    if (!reference) continue;

    const targetMap = new Map<string, string[]>();
    for (const record of records) {
      const value = record.record ? JSON.parse(record.record) : null;
      const targetUri = value
        ? getNestedValue(value, reference.field)
        : null;
      if (!targetUri) continue;
      const parentUris = targetMap.get(targetUri) ?? [];
      parentUris.push(record.uri);
      targetMap.set(targetUri, parentUris);
    }

    const targetUris = [...targetMap.keys()];
    if (targetUris.length === 0) continue;
    const rows = await batchedInQuery<Omit<RecordRow, "collection">>(
      db,
      `SELECT uri, did, rkey, record, time_us
       FROM ${recordsTableName(reference.collection)}
       WHERE uri IN (__IN__)`,
      [],
      targetUris,
    );

    const referenceNsid = config
      ? nsidForShortName(config, reference.collection) ?? reference.collection
      : reference.collection;
    for (const row of rows) {
      for (const parentUri of targetMap.get(row.uri) ?? []) {
        result[parentUri] ??= {};
        result[parentUri][referenceName] = formatRecord({
          ...(row as any),
          collection: referenceNsid,
        } as RecordRow);
      }
    }
  }
  return result;
}
