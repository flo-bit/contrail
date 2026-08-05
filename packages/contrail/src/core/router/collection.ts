import type { Context, Hono } from "hono";
import type {
  ContrailConfig,
  Database,
  QueryableField,
  RecordRow,
  RecordSource,
  RelationConfig,
  ResolvedContrailConfig,
} from "../types";
import {
  countColumnName,
  getCollectionMethods,
  getCollectionShortNames,
  groupedCountColumnName,
  nsidForShortName,
  recordsTableName,
} from "../types";
import { queryRecords } from "../db";
import type { SortOption } from "../db/records";
import { backfillUser } from "../backfill";
import {
  parseHydrateParams,
  resolveHydrates,
  resolveReferences,
} from "./hydrate";
import { collectDids, resolveProfiles } from "./profiles";
import { resolveActor } from "../identity";
import type { FormattedRecord } from "./helpers";
import { fieldToParam, formatRecord, parseIntParam } from "./helpers";
import { hydrateLabels } from "../labels/hydrate";
import { selectAcceptedLabelers } from "../labels/select";
import { parseResourceUri } from "@atcute/lexicons/syntax";

export async function runPipeline(
  db: Database,
  config: ContrailConfig,
  collection: string,
  params: URLSearchParams,
  source?: RecordSource,
  headers?: Headers,
): Promise<{
  records: FormattedRecord[];
  cursor?: string;
  profiles?: any[];
  labelersApplied?: string[];
}> {
  const colConfig = config.collections[collection];
  if (!colConfig) throw new Error(`Unknown collection: ${collection}`);

  const relations = colConfig.relations ?? {};
  const references = colConfig.references ?? {};
  const queryableFields: Record<string, QueryableField> =
    (config as ResolvedContrailConfig)._resolved?.queryable[collection] ??
    colConfig.queryable ??
    {};

  const limit = parseIntParam(params.get("limit"), 50);
  const cursor = params.get("cursor") || undefined;
  const actor = params.get("actor") || params.get("did") || undefined;
  const wantProfiles = params.get("profiles") === "true";

  let did: string | undefined;
  if (actor) {
    const resolved = await resolveActor(db, actor, config);
    if (!resolved) throw new Error("Could not resolve actor");
    did = resolved;
    const nsid = nsidForShortName(config, collection) ?? collection;
    await backfillUser(db, did, nsid, Date.now() + 3_000, config, {
      maxRetries: 0,
      requestTimeout: 3_000,
    });
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
  const relMap =
    (config as ResolvedContrailConfig)._resolved?.relations[collection] ?? {};
  for (const [relName, rel] of Object.entries(relations)) {
    const totalMin = parseIntParam(params.get(`${relName}CountMin`));
    if (totalMin != null) countFilters[rel.collection] = totalMin;
    const mapping = relMap[relName];
    if (mapping) {
      const capitalize = (value: string): string =>
        value.charAt(0).toUpperCase() + value.slice(1);
      for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
        const value = parseIntParam(
          params.get(`${relName}${capitalize(shortName)}CountMin`),
        );
        if (value != null) countFilters[fullToken] = value;
      }
    }
  }

  let sort: SortOption | undefined;
  const sortParam = params.get("sort");
  if (sortParam) {
    const orderParam = params.get("order");
    const fieldEntry = Object.entries(queryableFields).find(
      ([field]) => fieldToParam(field) === sortParam,
    );
    if (fieldEntry) {
      const defaultDirection =
        fieldEntry[1].type === "range" ? "desc" : "asc";
      const direction =
        orderParam === "asc" || orderParam === "desc"
          ? orderParam
          : defaultDirection;
      sort = { recordField: fieldEntry[0], direction };
    } else {
      const direction = orderParam === "asc" ? "asc" : "desc";
      const capitalize = (value: string): string =>
        value.charAt(0).toUpperCase() + value.slice(1);
      for (const [relName, rel] of Object.entries(relations)) {
        if (sortParam === `${relName}Count`) {
          sort = { countType: rel.collection, direction };
          break;
        }
        const mapping = relMap[relName];
        if (!mapping) continue;
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

  const result = await queryRecords(db, config, {
    collection,
    did,
    limit,
    cursor,
    filters,
    rangeFilters,
    countFilters,
    sort,
    search: params.get("search") || undefined,
    source,
  });

  const rows = result.records;
  const hydrateRequested = parseHydrateParams(params, relations, references);
  const hydrates = await resolveHydrates(
    db,
    relations,
    hydrateRequested.relations,
    rows,
    config,
  );
  const refs = await resolveReferences(
    db,
    references,
    hydrateRequested.references,
    rows,
    config,
  );

  const formattedRecords: FormattedRecord[] = rows.map((row) => {
    const formatted = formatRecord(row);
    flattenCounts(formatted, row.counts, relations);
    const hydratedRelations = hydrates[row.uri];
    if (hydratedRelations) {
      for (const [name, groups] of Object.entries(hydratedRelations)) {
        formatted[name] = groups;
      }
    }
    const hydratedReferences = refs[row.uri];
    if (hydratedReferences) {
      for (const [name, record] of Object.entries(hydratedReferences)) {
        formatted[name] = record;
      }
    }
    return formatted;
  });
  const allDids = collectDids(rows, hydrates);
  const profileMap = wantProfiles
    ? await resolveProfiles(db, config, allDids)
    : undefined;

  let labelersApplied: string[] | undefined;
  if (config.labels) {
    const selection = selectAcceptedLabelers(
      headers?.get("atproto-accept-labelers") ?? null,
      params.get("labelers"),
      config.labels,
    );
    if (selection.accepted.length > 0) {
      const subjects = [...formattedRecords.map((record) => record.uri), ...allDids];
      const cidByUri = new Map<string, string | null>();
      for (const record of formattedRecords) cidByUri.set(record.uri, record.cid);
      const labelsByUri = await hydrateLabels(
        db,
        subjects,
        selection.accepted,
        cidByUri,
      );
      for (const record of formattedRecords) {
        const labels = labelsByUri[record.uri];
        if (labels && labels.length > 0) record.labels = labels;
      }
      if (profileMap) {
        for (const entries of Object.values(profileMap)) {
          for (const entry of entries) {
            const labels = labelsByUri[entry.did];
            if (labels && labels.length > 0) entry.labels = labels;
          }
        }
      }
      labelersApplied = selection.accepted;
    }
  }

  return {
    records: formattedRecords,
    cursor: result.cursor,
    ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
    ...(labelersApplied ? { labelersApplied } : {}),
  };
}

function jsonWithLabelers(
  c: Context,
  result: { labelersApplied?: string[] } & Record<string, unknown>,
) {
  const { labelersApplied, ...body } = result;
  if (labelersApplied && labelersApplied.length > 0) {
    c.header("atproto-content-labelers", labelersApplied.join(","));
  }
  return c.json(body);
}

export function registerCollectionRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
): void {
  const ns = config.namespace;

  for (const collection of getCollectionShortNames(config)) {
    const colConfig = config.collections[collection];
    if (!colConfig) continue;
    const methods = getCollectionMethods(colConfig);

    if (methods.includes("listRecords")) {
      app.get(`/xrpc/${ns}.${collection}.listRecords`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        try {
          const result = await runPipeline(
            db,
            config,
            collection,
            params,
            undefined,
            c.req.raw.headers,
          );
          return jsonWithLabelers(c, result);
        } catch (error: any) {
          if (error.message === "Could not resolve actor") {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      });
    }

    if (methods.includes("getRecord")) {
      app.get(`/xrpc/${ns}.${collection}.getRecord`, async (c) => {
        const rawUri = c.req.query("uri");
        if (!rawUri) return c.json({ error: "uri parameter required" }, 400);

        const parsed = parseResourceUri(rawUri);
        if (!parsed.ok || parsed.value.rkey === undefined) {
          return c.json(
            {
              error: "InvalidRequest",
              message: "uri must be at://<actor>/<collection>/<rkey>",
            },
            400,
          );
        }
        const did = await resolveActor(db, parsed.value.repo, config);
        if (!did) return c.json({ error: "Could not resolve actor" }, 400);
        const uri = `at://${did}/${parsed.value.collection}/${parsed.value.rkey}`;

        const relations = colConfig.relations ?? {};
        const references = colConfig.references ?? {};
        const relMap =
          (config as ResolvedContrailConfig)._resolved?.relations[collection] ??
          {};
        const countCols = getRelationCountColumns(relations, relMap);
        const selectCols = [
          "uri",
          "did",
          "rkey",
          "cid",
          "record",
          "time_us",
          "indexed_at",
          ...countCols.map(({ column }) => column),
        ].join(", ");
        const row = await db
          .prepare(
            `SELECT ${selectCols} FROM ${recordsTableName(collection)} WHERE uri = ?`,
          )
          .bind(uri)
          .first<any>();

        if (!row) return c.json({ error: "Record not found" }, 404);

        const nsid = nsidForShortName(config, collection) ?? collection;
        const formatted = formatRecord({ ...row, collection: nsid });
        flattenCounts(formatted, extractCounts(row, relations), relations);

        const params = new URL(c.req.url).searchParams;
        const hydrateRequested = parseHydrateParams(
          params,
          relations,
          references,
        );
        const hydrates = await resolveHydrates(
          db,
          relations,
          hydrateRequested.relations,
          [row],
          config,
        );
        const refs = await resolveReferences(
          db,
          references,
          hydrateRequested.references,
          [row],
          config,
        );
        const hydratedRelations = hydrates[row.uri];
        if (hydratedRelations) {
          for (const [name, groups] of Object.entries(hydratedRelations)) {
            formatted[name] = groups;
          }
        }
        const hydratedReferences = refs[row.uri];
        if (hydratedReferences) {
          for (const [name, record] of Object.entries(hydratedReferences)) {
            formatted[name] = record;
          }
        }
        const allDids = collectDids([row], hydrates);
        const profileMap =
          params.get("profiles") === "true"
            ? await resolveProfiles(db, config, allDids)
            : undefined;

        let labelersApplied: string[] | undefined;
        if (config.labels) {
          const selection = selectAcceptedLabelers(
            c.req.raw.headers.get("atproto-accept-labelers"),
            params.get("labelers"),
            config.labels,
          );
          if (selection.accepted.length > 0) {
            const labelsByUri = await hydrateLabels(
              db,
              [row.uri, ...allDids],
              selection.accepted,
              new Map<string, string | null>([[row.uri, row.cid]]),
            );
            const labels = labelsByUri[row.uri];
            if (labels && labels.length > 0) formatted.labels = labels;
            if (profileMap) {
              for (const entries of Object.values(profileMap)) {
                for (const entry of entries) {
                  const profileLabels = labelsByUri[entry.did];
                  if (profileLabels && profileLabels.length > 0) {
                    entry.labels = profileLabels;
                  }
                }
              }
            }
            labelersApplied = selection.accepted;
          }
        }
        if (labelersApplied) {
          c.header("atproto-content-labelers", labelersApplied.join(","));
        }

        return c.json({
          ...formatted,
          ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
        });
      });
    }

    for (const [queryName, handler] of Object.entries(colConfig.queries ?? {})) {
      app.get(`/xrpc/${ns}.${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        return handler(db, params, config);
      });
    }

    for (const [queryName, handler] of Object.entries(
      colConfig.pipelineQueries ?? {},
    )) {
      app.get(`/xrpc/${ns}.${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        try {
          const source = await handler(db, params, config);
          const result = await runPipeline(
            db,
            config,
            collection,
            params,
            source,
            c.req.raw.headers,
          );
          return jsonWithLabelers(c, result);
        } catch (error: any) {
          if (error.message === "Could not resolve actor") {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      });
    }
  }
}

function getRelationCountColumns(
  relations: Record<string, RelationConfig>,
  relMap: Record<string, any>,
): { column: string }[] {
  const columns: { column: string }[] = [];
  for (const [relName, relation] of Object.entries(relations)) {
    if (relation.count === false) continue;
    columns.push({ column: countColumnName(relation.collection) });
    const mapping = relMap[relName];
    if (mapping?.groups) {
      for (const groupKey of Object.keys(mapping.groups)) {
        columns.push({
          column: groupedCountColumnName(relation.collection, groupKey),
        });
      }
    }
  }
  return columns;
}

function extractCounts(
  row: any,
  relations: Record<string, RelationConfig>,
): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const relation of Object.values(relations)) {
    if (relation.count === false) continue;
    const totalColumn = countColumnName(relation.collection);
    if (row[totalColumn] != null && row[totalColumn] !== 0) {
      counts[relation.collection] = row[totalColumn];
    }
    if (relation.groups) {
      for (const [groupKey, fullToken] of Object.entries(relation.groups)) {
        const column = groupedCountColumnName(relation.collection, groupKey);
        if (row[column] != null && row[column] !== 0) {
          counts[fullToken] = row[column];
        }
      }
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function flattenCounts(
  formatted: FormattedRecord,
  counts: Record<string, number> | undefined,
  relations: Record<string, RelationConfig>,
): void {
  if (!counts) return;
  const capitalize = (value: string): string =>
    value.charAt(0).toUpperCase() + value.slice(1);
  const collectionToRelName: Record<string, string> = {};
  const tokenToField: Record<string, string> = {};

  for (const [relName, relation] of Object.entries(relations)) {
    collectionToRelName[relation.collection] = relName;
    if (relation.groups) {
      for (const [shortName, fullToken] of Object.entries(relation.groups)) {
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
