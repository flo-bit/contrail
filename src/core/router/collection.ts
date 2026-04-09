import type { Hono } from "hono";
import type { ContrailConfig, ResolvedContrailConfig, Database, RecordRow, QueryableField, RecordSource, RelationConfig } from "../types";
import { getCollectionNames, countColumnName, recordsTableName } from "../types";
import { queryRecords } from "../db";
import type { SortOption } from "../db/records";
import { backfillUser } from "../backfill";
import { resolveHydrates, resolveReferences, parseHydrateParams } from "./hydrate";
import { resolveProfiles, collectDids } from "./profiles";
import { resolveActor } from "../identity";
import type { FormattedRecord } from "./helpers";
import { formatRecord, parseIntParam, fieldToParam } from "./helpers";

export async function runPipeline(
  db: Database,
  config: ContrailConfig,
  collection: string,
  params: URLSearchParams,
  source?: RecordSource
): Promise<{ records: FormattedRecord[]; cursor?: string; profiles?: any[] }> {
  const colConfig = config.collections[collection];
  if (!colConfig) throw new Error(`Unknown collection: ${collection}`);

  const relations = colConfig.relations ?? {};
  const references = colConfig.references ?? {};
  const queryableFields: Record<string, QueryableField> =
    (config as ResolvedContrailConfig)._resolved?.queryable[collection] ?? colConfig.queryable ?? {};

  const limit = parseIntParam(params.get("limit"), 50);
  const cursor = params.get("cursor") || undefined;
  const actor = params.get("actor") || params.get("did") || undefined;
  const wantProfiles = params.get("profiles") === "true";
  const wantBackfill = params.get("backfill") === "true";

  let did: string | undefined;
  if (actor) {
    const resolved = await resolveActor(db, actor);
    if (!resolved) throw new Error("Could not resolve actor");
    did = resolved;
    if (wantBackfill) {
      await backfillUser(db, did, collection, Date.now() + 10_000, config);
    }
  }

  const filters: Record<string, string> = {};
  const rangeFilters: Record<string, { min?: string; max?: string }> = {};
  for (const [field, fieldConfig] of Object.entries(queryableFields)) {
    const param = fieldToParam(field);
    if (fieldConfig.type === "range") {
      const min = params.get(`${param}Min`);
      const max = params.get(`${param}Max`);
      if (min || max) {
        rangeFilters[field] = {};
        if (min) rangeFilters[field].min = min;
        if (max) rangeFilters[field].max = max;
      }
    } else {
      const value = params.get(param);
      if (value) filters[field] = value;
    }
  }

  const countFilters: Record<string, number> = {};
  const relMap = (config as ResolvedContrailConfig)._resolved?.relations[collection] ?? {};
  for (const [relName, rel] of Object.entries(relations)) {
    const totalMin = parseIntParam(params.get(`${relName}CountMin`));
    if (totalMin != null) countFilters[rel.collection] = totalMin;
    const mapping = relMap[relName];
    if (mapping) {
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
        const val = parseIntParam(params.get(`${relName}${capitalize(shortName)}CountMin`));
        if (val != null) countFilters[fullToken] = val;
      }
    }
  }

  let sort: SortOption | undefined;
  const sortParam = params.get("sort");
  if (sortParam) {
    const orderParam = params.get("order");

    const fieldEntry = Object.entries(queryableFields).find(
      ([field]) => fieldToParam(field) === sortParam
    );
    if (fieldEntry) {
      const defaultDir = fieldEntry[1].type === "range" ? "desc" : "asc";
      const direction = orderParam === "asc" ? "asc" as const : orderParam === "desc" ? "desc" as const : defaultDir as "asc" | "desc";
      sort = { recordField: fieldEntry[0], direction };
    } else {
      const direction = orderParam === "asc" ? "asc" as const : "desc" as const;
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      for (const [relName, rel] of Object.entries(relations)) {
        if (sortParam === `${relName}Count`) {
          sort = { countType: rel.collection, direction };
          break;
        }
        const mapping = relMap[relName];
        if (mapping) {
          for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
            if (sortParam === `${relName}${capitalize(shortName)}Count`) {
              sort = { countType: fullToken, direction };
              break;
            }
          }
          if (sort) break;
        }
      }
    }
  }

  const search = params.get("search") || undefined;

  const result = await queryRecords(db, config, {
    collection,
    did,
    limit,
    cursor,
    filters,
    rangeFilters,
    countFilters,
    sort,
    search,
    source,
  });

  const rows = result.records;
  const hydrateRequested = parseHydrateParams(params, relations, references);
  const hydrates = await resolveHydrates(
    db,
    relations,
    hydrateRequested.relations,
    rows
  );
  const refs = await resolveReferences(
    db,
    references,
    hydrateRequested.references,
    rows
  );

  const formattedRecords: FormattedRecord[] = rows.map((row) => {
    const formatted = formatRecord(row);
    flattenCounts(formatted, row.counts, relations);
    const h = hydrates[row.uri];
    if (h) {
      for (const [relName, groups] of Object.entries(h)) {
        formatted[relName] = groups;
      }
    }
    const r = refs[row.uri];
    if (r) {
      for (const [refName, record] of Object.entries(r)) {
        formatted[refName] = record;
      }
    }
    return formatted;
  });

  const allDids = collectDids(rows, hydrates);
  const profileMap = wantProfiles
    ? await resolveProfiles(db, config, allDids)
    : undefined;

  return {
    records: formattedRecords,
    cursor: result.cursor,
    ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
  };
}

export function registerCollectionRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig
): void {
  for (const collection of getCollectionNames(config)) {
    const colConfig = config.collections[collection];

    app.get(`/xrpc/${collection}.listRecords`, async (c) => {
      const params = new URL(c.req.url).searchParams;
      try {
        const result = await runPipeline(db, config, collection, params);
        return c.json(result);
      } catch (e: any) {
        if (e.message === "Could not resolve actor") {
          return c.json({ error: e.message }, 400);
        }
        throw e;
      }
    });

    app.get(`/xrpc/${collection}.getRecord`, async (c) => {
      const uri = c.req.query("uri");
      if (!uri) return c.json({ error: "uri parameter required" }, 400);

      const relations = colConfig.relations ?? {};
      const references = colConfig.references ?? {};
      const relMap = (config as ResolvedContrailConfig)._resolved?.relations[collection] ?? {};

      const table = recordsTableName(collection);
      const countCols = getRelationCountColumns(relations, relMap);
      const selectCols = `uri, did, rkey, cid, record, time_us, indexed_at${countCols.length > 0 ? ", " + countCols.map(c => c.column).join(", ") : ""}`;
      const row = await db
        .prepare(`SELECT ${selectCols} FROM ${table} WHERE uri = ?`)
        .bind(uri)
        .first<any>();

      if (!row) return c.json({ error: "Record not found" }, 404);

      const formatted = formatRecord({ ...row, collection });
      const counts = extractCounts(row, relations);
      if (counts) flattenCounts(formatted, counts, relations);

      const params = new URL(c.req.url).searchParams;
      const wantProfilesSingle = params.get("profiles") === "true";

      const hydrateRequested = parseHydrateParams(params, relations, references);
      const hydrates = await resolveHydrates(
        db,
        relations,
        hydrateRequested.relations,
        [row]
      );
      const refs = await resolveReferences(
        db,
        references,
        hydrateRequested.references,
        [row]
      );
      const h = hydrates[row.uri];
      if (h) {
        for (const [relName, groups] of Object.entries(h)) {
          (formatted as any)[relName] = groups;
        }
      }
      const r = refs[row.uri];
      if (r) {
        for (const [refName, record] of Object.entries(r)) {
          (formatted as any)[refName] = record;
        }
      }

      const allDids = collectDids([row], hydrates);
      const profileMap = wantProfilesSingle
        ? await resolveProfiles(db, config, allDids)
        : undefined;

      return c.json({
        ...formatted,
        ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
      });
    });

    for (const [queryName, handler] of Object.entries(
      colConfig.queries ?? {}
    )) {
      app.get(`/xrpc/${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        return handler(db, params, config);
      });
    }

    for (const [queryName, handler] of Object.entries(
      colConfig.pipelineQueries ?? {}
    )) {
      app.get(`/xrpc/${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        try {
          const source = await handler(db, params, config);
          const result = await runPipeline(db, config, collection, params, source);
          return c.json(result);
        } catch (e: any) {
          if (e.message === "Could not resolve actor") {
            return c.json({ error: e.message }, 400);
          }
          throw e;
        }
      });
    }
  }
}

function getRelationCountColumns(
  relations: Record<string, RelationConfig>,
  relMap: Record<string, any>
): { column: string }[] {
  const cols: { column: string }[] = [];
  for (const [relName, rel] of Object.entries(relations)) {
    if (rel.count === false) continue;
    cols.push({ column: countColumnName(rel.collection) });
    const mapping = relMap[relName];
    if (mapping?.groups) {
      for (const [, fullToken] of Object.entries(mapping.groups as Record<string, string>)) {
        cols.push({ column: countColumnName(fullToken) });
      }
    }
  }
  return cols;
}

function extractCounts(
  row: any,
  relations: Record<string, any>
): Record<string, number> | undefined {
  const counts: Record<string, number> = {};

  for (const [, rel] of Object.entries(relations)) {
    if (rel.count === false) continue;
    const totalCol = countColumnName(rel.collection);
    const val = row[totalCol];
    if (val != null && val !== 0) counts[rel.collection] = val;

    if (rel.groups) {
      for (const [, fullToken] of Object.entries(rel.groups as Record<string, string>)) {
        const groupCol = countColumnName(fullToken);
        const gval = row[groupCol];
        if (gval != null && gval !== 0) counts[fullToken] = gval;
      }
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

function flattenCounts(
  formatted: FormattedRecord,
  counts: Record<string, number> | undefined,
  relations: Record<string, any>
): void {
  if (!counts) return;
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const collectionToRelName: Record<string, string> = {};
  const tokenToField: Record<string, string> = {};
  for (const [relName, rel] of Object.entries(relations)) {
    collectionToRelName[rel.collection] = relName;
    if (rel.groups) {
      for (const [shortName, fullToken] of Object.entries(rel.groups as Record<string, string>)) {
        tokenToField[fullToken] = `${relName}${capitalize(shortName)}Count`;
      }
    }
  }

  for (const [type, count] of Object.entries(counts)) {
    if (collectionToRelName[type]) {
      formatted[`${collectionToRelName[type]}Count`] = count;
    } else if (tokenToField[type]) {
      formatted[tokenToField[type]] = count;
    }
  }
}
