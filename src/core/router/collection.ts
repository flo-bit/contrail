import type { Hono } from "hono";
import type { ContrailConfig, Database, RecordRow, QueryableField } from "../types";
import { getCollectionNames } from "../types";
import { resolvedQueryable, resolvedRelationsMap } from "../queryable.generated";
import { queryRecords } from "../db";
import type { SortOption } from "../db/records";
import { backfillUser } from "../backfill";
import { resolveHydrates, resolveReferences, parseHydrateParams } from "./hydrate";
import { resolveProfiles, collectDids } from "./profiles";
import { resolveActor } from "../identity";
import type { FormattedRecord } from "./helpers";
import { formatRecord, parseIntParam, fieldToParam } from "./helpers";

export function registerCollectionRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig
): void {
  for (const collection of getCollectionNames(config)) {
    const colConfig = config.collections[collection];
    const relations = colConfig.relations ?? {};
    const references = colConfig.references ?? {};
    const queryableFields: Record<string, QueryableField> =
      resolvedQueryable[collection] ?? colConfig.queryable ?? {};

    app.get(`/xrpc/${collection}.listRecords`, async (c) => {
      const params = new URL(c.req.url).searchParams;
      const limit = parseIntParam(params.get("limit"), 50);
      const cursor = params.get("cursor") || undefined;
      const actor = params.get("actor") || params.get("did") || undefined;
      const wantProfiles = params.get("profiles") === "true";

      let did: string | undefined;
      if (actor) {
        const resolved = await resolveActor(db, actor);
        if (!resolved) return c.json({ error: "Could not resolve actor" }, 400);
        did = resolved;
        await backfillUser(db, did, collection, Date.now() + 10_000, config);
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
      const relMap = resolvedRelationsMap[collection] ?? {};
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

      // Resolve sort option
      let sort: SortOption | undefined;
      const sortParam = params.get("sort");
      if (sortParam) {
        const orderParam = params.get("order");

        // Check if it's a queryable field (param name → json path)
        const fieldEntry = Object.entries(queryableFields).find(
          ([field]) => fieldToParam(field) === sortParam
        );
        if (fieldEntry) {
          // Default: desc for range fields (dates, numbers), asc for others
          const defaultDir = fieldEntry[1].type === "range" ? "desc" : "asc";
          const direction = orderParam === "asc" ? "asc" as const : orderParam === "desc" ? "desc" as const : defaultDir as "asc" | "desc";
          sort = { recordField: fieldEntry[0], direction };
        } else {
          // Count fields default to desc (you usually want "most X first")
          const direction = orderParam === "asc" ? "asc" as const : "desc" as const;
          // Check if it's a count field (e.g. rsvpsCount → collection NSID, rsvpsGoingCount → full token)
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
        flattenCounts(formatted, row.counts, collection, relations);
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

      return c.json({
        records: formattedRecords,
        cursor: result.cursor,
        ...(profileMap ? { profiles: Object.values(profileMap) } : {}),
      });
    });

    app.get(`/xrpc/${collection}.getRecord`, async (c) => {
      const uri = c.req.query("uri");
      if (!uri) return c.json({ error: "uri parameter required" }, 400);

      const row = await db
        .prepare(
          "SELECT uri, did, collection, rkey, cid, record, time_us, indexed_at FROM records WHERE uri = ? AND collection = ?"
        )
        .bind(uri, collection)
        .first<RecordRow>();

      if (!row) return c.json({ error: "Record not found" }, 404);

      const countRows = await db
        .prepare("SELECT type, count FROM counts WHERE uri = ?")
        .bind(uri)
        .all<{ type: string; count: number }>();

      const formatted = formatRecord(row);
      if (countRows.results?.length) {
        const counts: Record<string, number> = {};
        for (const cr of countRows.results) counts[cr.type] = cr.count;
        flattenCounts(formatted, counts, collection, relations);
      }

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
        ...(profileMap ? { profiles: Object.values(profileMap) } : {}),
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
  }
}

function flattenCounts(
  formatted: FormattedRecord,
  counts: Record<string, number> | undefined,
  collection: string,
  relations: Record<string, any>
): void {
  if (!counts) return;
  const relMap = resolvedRelationsMap[collection] ?? {};
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Build reverse lookups: collection NSID → relName (for totals), full token → field name (for groups)
  const collectionToRelName: Record<string, string> = {};
  const tokenToField: Record<string, string> = {};
  for (const [relName, mapping] of Object.entries(relMap)) {
    collectionToRelName[mapping.collection] = relName;
    for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
      tokenToField[fullToken] = `${relName}${capitalize(shortName)}Count`;
    }
  }
  // Also map relations without groupBy (no entry in relMap)
  for (const [relName, rel] of Object.entries(relations)) {
    if (!collectionToRelName[rel.collection]) {
      collectionToRelName[rel.collection] = relName;
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
