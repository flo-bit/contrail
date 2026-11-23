import type {
  ContrailConfig,
  Database,
  IngestEvent,
  Statement,
} from "../types";
import { recordsTableName, resolveCollectionKey } from "../types";

// D1 accepts at most 100 bound parameters per statement. Packing rows avoids
// one prepared statement per record while leaving the SQL valid across D1,
// SQLite, and PostgreSQL.
export const MAX_STATEMENT_BINDINGS = 100;
const RECORD_VERSION_BINDINGS = 13;
const RECORD_VERSION_ROWS = Math.floor(
  MAX_STATEMENT_BINDINGS / RECORD_VERSION_BINDINGS,
);
const PROJECTION_GUARD_URIS = 40;

/** Max UTF-8 bytes per `json_each(?)` bulk upsert payload on SQLite/D1. Keeps
 * each statement comfortably below D1's payload/CPU ceilings while collapsing
 * dozens of multi-row VALUES statements into one prepared statement. */
const MAX_BULK_JSON_BYTES = 256 * 1024;
const BULK_JSON_ENCODER = new TextEncoder();

export function chunkJsonArrayRows(
  rows: unknown[][],
  maxBytes: number = MAX_BULK_JSON_BYTES,
): string[] {
  const payloads: string[] = [];
  let parts: string[] = [];
  let bytes = 2; // "[]"
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const rowBytes = BULK_JSON_ENCODER.encode(encoded).byteLength;
    const extra = parts.length === 0 ? rowBytes : rowBytes + 1;
    if (parts.length > 0 && bytes + extra > maxBytes) {
      payloads.push(`[${parts.join(",")}]`);
      parts = [encoded];
      bytes = 2 + rowBytes;
    } else {
      parts.push(encoded);
      bytes += extra;
    }
  }
  if (parts.length > 0) payloads.push(`[${parts.join(",")}]`);
  return payloads;
}

export interface ExistingRecordInfo {
  cid: string | null;
  record: string | null;
  /** When the row was last written to our DB (microseconds). Populated
   *  whenever `lookupExistingRecords` runs, regardless of `includeRecord`. */
  indexed_at: number | null;
}

export interface RecordVersionInfo {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  operation: "create" | "update" | "delete";
  cid: string | null;
  source_id: string;
  source_epoch: string | null;
  source_revision: string | null;
  source_time_us: number;
  source_cursor: string | null;
  indexed_at: number;
  /** Opaque optimistic-concurrency token; not part of source ordering. */
  projection_token: string;
}

type ComparableRecordVersion = Omit<RecordVersionInfo, "projection_token">;

function versionForEvent(event: IngestEvent): ComparableRecordVersion {
  const source = event.source;
  return {
    uri: event.uri,
    did: event.did,
    collection: event.collection,
    rkey: event.rkey,
    operation: event.operation,
    cid: event.cid,
    source_id: source?.id ?? "legacy-caller",
    source_epoch: source?.epoch ?? null,
    // Before 0.13.1 callers had no separate source clock, so time_us is the
    // least surprising compatibility fallback for hand-built IngestEvents.
    source_time_us: source?.time_us ?? event.time_us,
    source_revision: source?.revision ?? null,
    source_cursor: source?.cursor ?? null,
    indexed_at: event.indexed_at,
  };
}

function comparePositionStrings(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationRank(operation: RecordVersionInfo["operation"]): number {
  if (operation === "delete") return 3;
  if (operation === "update") return 2;
  return 1;
}

/**
 * Compare two observations of one canonical URI. Repository revisions are the
 * strongest signal when both sides have one. Otherwise source event/observation
 * time orders adapters consistently. Remaining comparisons are deterministic
 * tie-breakers; notably a delete wins an exact tie so replay cannot resurrect it.
 */
export function compareRecordVersions(
  left: ComparableRecordVersion,
  right: ComparableRecordVersion,
): number {
  if (
    left.source_revision !== null &&
    right.source_revision !== null &&
    left.source_revision !== right.source_revision
  ) {
    return comparePositionStrings(left.source_revision, right.source_revision);
  }
  if (left.source_time_us !== right.source_time_us) {
    return left.source_time_us < right.source_time_us ? -1 : 1;
  }
  if ((left.source_revision === null) !== (right.source_revision === null)) {
    return left.source_revision === null ? -1 : 1;
  }
  if (
    left.source_id === right.source_id &&
    left.source_epoch === right.source_epoch &&
    left.source_cursor !== null &&
    right.source_cursor !== null &&
    left.source_cursor !== right.source_cursor
  ) {
    return comparePositionStrings(left.source_cursor, right.source_cursor);
  }
  const operationDifference =
    operationRank(left.operation) - operationRank(right.operation);
  if (operationDifference !== 0) return operationDifference;
  const leftCid = left.cid ?? "";
  const rightCid = right.cid ?? "";
  if (leftCid !== rightCid) return leftCid < rightCid ? -1 : 1;
  if (left.source_id !== right.source_id) {
    return left.source_id < right.source_id ? -1 : 1;
  }
  const leftEpoch = left.source_epoch ?? "";
  const rightEpoch = right.source_epoch ?? "";
  if (leftEpoch !== rightEpoch) return leftEpoch < rightEpoch ? -1 : 1;
  return 0;
}

export async function lookupRecordVersions(
  db: Database,
  uris: Iterable<string>,
): Promise<Map<string, RecordVersionInfo>> {
  const uniqueUris = [...new Set(uris)];
  const versions = new Map<string, RecordVersionInfo>();
  for (let index = 0; index < uniqueUris.length; index += 50) {
    const chunk = uniqueUris.slice(index, index + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT uri, did, collection, rkey, operation, cid, source_id, source_epoch, source_revision, source_time_us, source_cursor, indexed_at, projection_token FROM record_versions WHERE uri IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<RecordVersionInfo>();
    for (const row of rows.results ?? []) versions.set(row.uri, row);
  }
  return versions;
}

export interface MutationSelection {
  applied: IngestEvent[];
  superseded: number;
}

export function selectMutationWinners(
  events: IngestEvent[],
  durable: ReadonlyMap<string, RecordVersionInfo>,
): MutationSelection {
  const winners = new Map<
    string,
    { event: IngestEvent; version: ComparableRecordVersion; index: number }
  >();
  let superseded = 0;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const version = versionForEvent(event);
    const batchWinner = winners.get(event.uri);
    const current = batchWinner?.version ?? durable.get(event.uri);
    if (current && compareRecordVersions(version, current) <= 0) {
      superseded++;
      continue;
    }
    if (batchWinner) superseded++;
    winners.set(event.uri, { event, version, index });
  }

  return {
    applied: [...winners.values()]
      .sort((left, right) => left.index - right.index)
      .map((winner) => winner.event),
    superseded,
  };
}

/** Deduplicate one authoritative source observation without a durable lookup. */
export function selectAuthoritativeMutations(
  events: IngestEvent[],
): MutationSelection {
  return selectMutationWinners(events, new Map());
}

/** Select one newest mutation per URI and reject rows older than durable state. */
export async function selectCurrentMutations(
  db: Database,
  events: IngestEvent[],
): Promise<MutationSelection> {
  if (events.length === 0) return { applied: [], superseded: 0 };
  const durable = await lookupRecordVersions(
    db,
    events.map((event) => event.uri),
  );
  return selectMutationWinners(events, durable);
}

/**
 * Look up existing records for a set of events, grouped by collection.
 * Returns a map of uri → { cid, record }.
 * When includeRecord is false, record will always be null (saves reading large blobs).
 */
export async function lookupExistingRecords(
  db: Database,
  events: { uri: string; collection: string }[],
  includeRecord: boolean = true,
  config?: ContrailConfig,
): Promise<Map<string, ExistingRecordInfo>> {
  const result = new Map<string, ExistingRecordInfo>();
  if (events.length === 0) return result;

  // Group by short name (config lookup); skip events for collections not in our config.
  const byShort = new Map<string, string[]>();
  for (const e of events) {
    const short = config
      ? resolveCollectionKey(config, e.collection)
      : e.collection;
    if (!short) continue;
    const uris = byShort.get(short) ?? [];
    uris.push(e.uri);
    byShort.set(short, uris);
  }

  const selectCols = includeRecord
    ? "uri, cid, record, indexed_at"
    : "uri, cid, indexed_at";
  for (const [short, uris] of byShort) {
    const table = recordsTableName(short);
    for (let i = 0; i < uris.length; i += 50) {
      const chunk = uris.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(
          `SELECT ${selectCols} FROM ${table} WHERE uri IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{
          uri: string;
          cid: string | null;
          record?: string | null;
          indexed_at: number | null;
        }>();
      for (const row of rows.results ?? []) {
        result.set(row.uri, {
          cid: row.cid,
          record: includeRecord ? (row.record ?? null) : null,
          indexed_at: row.indexed_at ?? null,
        });
      }
    }
  }

  return result;
}

export function buildRecordVersionStatements(
  db: Database,
  events: IngestEvent[],
  existing: Map<string, ExistingRecordInfo>,
  projectionTokens: ReadonlyMap<string, string>,
  useJsonBulk = false,
): Statement[] {
  const versionTuple = (event: IngestEvent) => {
    const version = versionForEvent(event);
    const retainedCid =
      event.operation === "delete"
        ? (version.cid ?? existing.get(event.uri)?.cid ?? null)
        : version.cid;
    return [
      version.uri,
      version.did,
      version.collection,
      version.rkey,
      version.operation,
      retainedCid,
      version.source_id,
      version.source_epoch,
      version.source_revision,
      version.source_time_us,
      version.source_cursor,
      version.indexed_at,
      projectionTokens.get(event.uri)!,
    ];
  };

  if (useJsonBulk && events.length > 1) {
    const payloads = chunkJsonArrayRows(events.map(versionTuple));
    return payloads.map((payload) =>
      db
        .prepare(
          `INSERT INTO record_versions (uri, did, collection, rkey, operation, cid, source_id, source_epoch, source_revision, source_time_us, source_cursor, indexed_at, projection_token)
           SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
                  json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'),
                  json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), json_extract(j.value, '$[8]'),
                  json_extract(j.value, '$[9]'), json_extract(j.value, '$[10]'), json_extract(j.value, '$[11]'),
                  json_extract(j.value, '$[12]')
           FROM json_each(?) AS j
           WHERE true
           ON CONFLICT(uri) DO UPDATE SET did = excluded.did, collection = excluded.collection, rkey = excluded.rkey, operation = excluded.operation, cid = excluded.cid, source_id = excluded.source_id, source_epoch = excluded.source_epoch, source_revision = excluded.source_revision, source_time_us = excluded.source_time_us, source_cursor = excluded.source_cursor, indexed_at = excluded.indexed_at, projection_token = excluded.projection_token`,
        )
        .bind(payload),
    );
  }

  const statements: Statement[] = [];
  for (let index = 0; index < events.length; index += RECORD_VERSION_ROWS) {
    const chunk = events.slice(index, index + RECORD_VERSION_ROWS);
    const values = chunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO record_versions (uri, did, collection, rkey, operation, cid, source_id, source_epoch, source_revision, source_time_us, source_cursor, indexed_at, projection_token) VALUES ${values} ON CONFLICT(uri) DO UPDATE SET did = excluded.did, collection = excluded.collection, rkey = excluded.rkey, operation = excluded.operation, cid = excluded.cid, source_id = excluded.source_id, source_epoch = excluded.source_epoch, source_revision = excluded.source_revision, source_time_us = excluded.source_time_us, source_cursor = excluded.source_cursor, indexed_at = excluded.indexed_at, projection_token = excluded.projection_token`,
        )
        .bind(...chunk.flatMap(versionTuple)),
    );
  }
  return statements;
}

export function buildProjectionGuardStatements(
  db: Database,
  events: IngestEvent[],
  predecessors: ReadonlyMap<string, RecordVersionInfo>,
): Statement[] {
  const uris = [...new Set(events.map((event) => event.uri))];
  const statements: Statement[] = [
    db.prepare(
      `INSERT INTO _contrail_projection_state (id, revision, guard)
       VALUES (1, 0, 1) ON CONFLICT(id) DO NOTHING`,
    ),
    // PostgreSQL takes a row lock here. The following statement then receives a
    // fresh READ COMMITTED snapshot after any earlier projector commits. SQLite
    // and D1 already serialize the containing write batch.
    db.prepare(
      `UPDATE _contrail_projection_state
       SET revision = revision + 1
       WHERE id = 1`,
    ),
  ];
  for (let index = 0; index < uris.length; index += PROJECTION_GUARD_URIS) {
    const chunk = uris.slice(index, index + PROJECTION_GUARD_URIS);
    const conditions: string[] = [];
    const bindings: string[] = [];
    for (const uri of chunk) {
      const predecessor = predecessors.get(uri);
      if (!predecessor) {
        conditions.push(
          "NOT EXISTS (SELECT 1 FROM record_versions WHERE uri = ?)",
        );
        bindings.push(uri);
        continue;
      }
      if (!predecessor.projection_token) {
        throw new Error(`Record version ${uri} has no projection token`);
      }
      conditions.push(
        "EXISTS (SELECT 1 FROM record_versions WHERE uri = ? AND projection_token = ?)",
      );
      bindings.push(uri, predecessor.projection_token);
    }
    statements.push(
      db
        .prepare(
          `UPDATE _contrail_projection_state
           SET guard = CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END
           WHERE id = 1`,
        )
        .bind(...bindings),
    );
  }
  return statements;
}

/** Adapter-neutral classification for the named optimistic guard constraint. */
export function isProjectionConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  return (
    (candidate.code === "23514" &&
      candidate.constraint === "projection_guard_valid") ||
    /projection_guard_valid/i.test(String(candidate.message ?? ""))
  );
}
