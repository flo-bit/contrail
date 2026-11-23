import type {
  ContrailConfig,
  Database,
  RecordRow,
  RecordSource,
} from "../types";
import {
  nsidForShortName,
  recordsTableName,
  shortNameForNsid,
} from "../types";
import { getSearchableFields } from "../search";
import { ftsQueryClause, getDialect } from "../dialect";
import { visibleRecordSql } from "../moderation";
import { countColumnForType, getCountColumns } from "./counts";

export interface SortOption {
  recordField?: string;
  countType?: string;
  direction: "asc" | "desc";
}

/** Opaque keyset cursor. `v` is the primary sort value, `t` is time,
 *  and `u` is the final unique tiebreaker. */
interface CursorPayload {
  t: number;
  u: string;
  v?: string | number | null;
  k: "time" | "search" | string;
}

function sortKind(sort?: SortOption): "time" | string {
  if (sort?.recordField) return `field:${sort.recordField}`;
  if (sort?.countType) return `count:${sort.countType}`;
  return "time";
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeCursor(payload: CursorPayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const p = JSON.parse(decodeBase64Url(cursor));
    if (
      typeof p?.t !== "number" ||
      typeof p?.u !== "string" ||
      typeof p?.k !== "string"
    ) {
      return null;
    }
    return p as CursorPayload;
  } catch {
    return null;
  }
}

export interface QueryOptions {
  collection: string;
  did?: string;
  limit?: number;
  cursor?: string;
  filters?: Record<string, string>;
  rangeFilters?: Record<string, { min?: string; max?: string }>;
  countFilters?: Record<string, number>;
  sort?: SortOption;
  search?: string;
  source?: RecordSource;
}

export async function queryRecords(
  db: Database,
  config: ContrailConfig,
  options: QueryOptions,
): Promise<{
  records: (RecordRow & { counts?: Record<string, number> })[];
  cursor?: string;
}> {
  const {
    collection: collectionInput,
    did,
    limit: rawLimit,
    cursor,
    filters = {},
    rangeFilters = {},
    countFilters = {},
    sort,
    search,
    source,
  } = options;

  // Accept either the short name (canonical) or the full NSID for convenience.
  const collection = config.collections[collectionInput]
    ? collectionInput
    : (shortNameForNsid(config, collectionInput) ?? collectionInput);

  const table = recordsTableName(collection);
  const limit = Math.min(Math.max(1, rawLimit ?? 50), 200);
  const conditions: string[] = [visibleRecordSql("r")];
  const bindings: (string | number)[] = [];

  if (source?.conditions) conditions.push(...source.conditions);
  if (source?.params) bindings.push(...source.params);

  const countCols = getCountColumns(config, collection);

  if (did) {
    conditions.push("r.did = ?");
    bindings.push(did);
  }

  const dialect = getDialect(db);
  let ftsJoin = "";
  let ftsClause: ReturnType<typeof ftsQueryClause> | null = null;
  if (search) {
    const collectionConfig = config.collections[collection];
    const fields = collectionConfig
      ? getSearchableFields(collection, collectionConfig)
      : null;
    if (fields && fields.length > 0) {
      ftsClause = ftsQueryClause(dialect, recordsTableName(collection));
      ftsJoin = ftsClause.join;
      conditions.push(ftsClause.condition);
      bindings.push(search);
    }
  }

  // Cursors are accepted only for the ordering that created them. URI is the
  // final key so rows with identical sort values and timestamps cannot vanish.
  const expectedKind = sort ? sortKind(sort) : ftsClause ? "search" : "time";
  if (cursor) {
    const payload = decodeCursor(cursor);
    if (payload && payload.k === expectedKind) {
      const stableTail = "(r.time_us < ? OR (r.time_us = ? AND r.uri > ?))";
      if (sort?.recordField) {
        const sortExpr = dialect.jsonExtract("r.record", sort.recordField);
        if (payload.v === null) {
          conditions.push(`(${sortExpr} IS NULL AND ${stableTail})`);
          bindings.push(payload.t, payload.t, payload.u);
        } else if (payload.v !== undefined) {
          const cmp = sort.direction === "desc" ? "<" : ">";
          conditions.push(
            `(${sortExpr} ${cmp} ? OR (${sortExpr} = ? AND ${stableTail}) OR ${sortExpr} IS NULL)`,
          );
          bindings.push(
            payload.v,
            payload.v,
            payload.t,
            payload.t,
            payload.u,
          );
        }
      } else if (sort?.countType) {
        const sortCol = countColumnForType(config, collection, sort.countType);
        if (!sortCol) throw new Error(`Unknown countType: ${sort.countType}`);
        const cmp = sort.direction === "desc" ? "<" : ">";
        const value = Number(payload.v ?? 0);
        conditions.push(
          `(r.${sortCol} ${cmp} ? OR (r.${sortCol} = ? AND ${stableTail}))`,
        );
        bindings.push(value, value, payload.t, payload.t, payload.u);
      } else if (ftsClause && search && typeof payload.v === "number") {
        const rankExpr = ftsClause.orderExpr;
        const cmp = ftsClause.orderDirection === "desc" ? "<" : ">";
        conditions.push(
          `(${rankExpr} ${cmp} ? OR (${rankExpr} = ? AND ${stableTail}))`,
        );
        if (dialect.ftsStrategy === "generated-column") {
          bindings.push(
            search,
            payload.v,
            search,
            payload.v,
            payload.t,
            payload.t,
            payload.u,
          );
        } else {
          bindings.push(
            payload.v,
            payload.v,
            payload.t,
            payload.t,
            payload.u,
          );
        }
      } else if (!ftsClause) {
        // Expose the time bound outside the tie-breaking OR so an equality
        // filter's (field, time_us DESC, uri ASC) index can seek to a deep page
        // instead of visiting every earlier match. The tail still preserves
        // every URI when records share the cursor timestamp.
        conditions.push(`(r.time_us <= ? AND ${stableTail})`);
        bindings.push(payload.t, payload.t, payload.t, payload.u);
      }
    }
  }

  for (const [field, value] of Object.entries(filters)) {
    conditions.push(`${dialect.jsonExtract("r.record", field)} = ?`);
    bindings.push(value);
  }

  for (const [field, range] of Object.entries(rangeFilters)) {
    if (range.min != null) {
      conditions.push(`${dialect.jsonExtract("r.record", field)} >= ?`);
      bindings.push(range.min);
    }
    if (range.max != null) {
      conditions.push(`${dialect.jsonExtract("r.record", field)} <= ?`);
      bindings.push(range.max);
    }
  }

  for (const [type, minCount] of Object.entries(countFilters)) {
    const col = countColumnForType(config, collection, type);
    if (!col) continue; // unknown count type — skip filter
    conditions.push(`r.${col} >= ?`);
    bindings.push(minCount);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSelect =
    countCols.length > 0
      ? ", " + countCols.map(({ column }) => `r.${column}`).join(", ")
      : "";
  const selectBindings: (string | number)[] = [];
  const fieldSortSelect = sort?.recordField
    ? `, ${dialect.jsonExtract("r.record", sort.recordField)} AS __sort_value`
    : "";
  let searchRankSelect = "";
  if (expectedKind === "search" && ftsClause && search) {
    searchRankSelect = `, ${ftsClause.orderExpr} AS __search_rank`;
    if (dialect.ftsStrategy === "generated-column") {
      selectBindings.push(search);
    }
  }
  const select = `r.uri, r.did, r.rkey, r.cid, r.record, r.time_us, r.indexed_at${countSelect}${fieldSortSelect}${searchRankSelect}`;

  const join = [source?.joins, ftsJoin].filter(Boolean).join(" ");
  const orderBindings: (string | number)[] = [];

  let orderBy: string;
  if (sort?.recordField) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderBy = `${dialect.jsonExtract("r.record", sort.recordField)} ${dir} NULLS LAST, r.time_us DESC, r.uri ASC`;
  } else if (sort?.countType) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    const sortCol = countColumnForType(config, collection, sort.countType);
    if (!sortCol) throw new Error(`Unknown countType: ${sort.countType}`);
    orderBy = `r.${sortCol} ${dir}, r.time_us DESC, r.uri ASC`;
  } else if (ftsClause) {
    const dir = ftsClause.orderDirection.toUpperCase();
    orderBy = `${ftsClause.orderExpr} ${dir}, r.time_us DESC, r.uri ASC`;
    if (dialect.ftsStrategy === "generated-column" && search) {
      orderBindings.push(search);
    }
  } else {
    orderBy = "r.time_us DESC, r.uri ASC";
  }

  const query = `SELECT ${select} FROM ${table} r ${join} ${where} ORDER BY ${orderBy} LIMIT ?`;

  const result = await db
    .prepare(query)
    .bind(...selectBindings, ...bindings, ...orderBindings, limit)
    .all<any>();
  const rows = result.results ?? [];

  const nsid = nsidForShortName(config, collection) ?? collection;
  const records = rows.map((row: any) => {
    const rec: RecordRow & { counts?: Record<string, number> } = {
      uri: row.uri,
      did: row.did,
      collection: nsid,
      rkey: row.rkey,
      cid: row.cid,
      record: row.record,
      time_us: row.time_us,
      indexed_at: row.indexed_at,
    };
    if (countCols.length > 0) {
      const counts: Record<string, number> = {};
      for (const { type, column } of countCols) {
        const val = row[column];
        if (val != null && val !== 0) counts[type] = val;
      }
      if (Object.keys(counts).length > 0) rec.counts = counts;
    }
    return rec;
  });

  const nextCursor =
    records.length === limit
      ? buildCursor(
          records[records.length - 1],
          sort,
          expectedKind,
          rows[rows.length - 1]?.__sort_value,
          rows[rows.length - 1]?.__search_rank,
        )
      : undefined;

  return { records, cursor: nextCursor };
}

/** Build an opaque keyset cursor from the last row of a page. */
function buildCursor(
  row: RecordRow & { counts?: Record<string, number> },
  sort: SortOption | undefined,
  kind: string,
  fieldSortValue?: unknown,
  searchRank?: unknown,
): string {
  const t = Number(row.time_us);
  const u = row.uri;
  if (sort?.recordField) {
    const v =
      fieldSortValue === null ||
      typeof fieldSortValue === "string" ||
      typeof fieldSortValue === "number"
        ? fieldSortValue
        : null;
    return encodeCursor({ t, u, v, k: kind });
  }
  if (sort?.countType) {
    const v = row.counts?.[sort.countType] ?? 0;
    return encodeCursor({ t, u, v, k: kind });
  }
  if (kind === "search") {
    const v = Number(searchRank);
    if (!Number.isFinite(v)) throw new Error("Search rank missing from result");
    return encodeCursor({ t, u, v, k: kind });
  }
  return encodeCursor({ t, u, k: kind });
}
