import { isDid } from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database, IngestEvent } from "./types";
import {
  getNestedValue,
  resolveCollectionKey,
} from "./types";
import {
  projectEvents,
  type ExistingRecordInfo,
} from "./db/records";

export interface RecordEventInput {
  uri?: string;
  did: string;
  collection: string;
  rkey: string;
  operation: "create" | "update" | "delete";
  cid?: string | null;
  value?: unknown;
  timeUs: number;
  indexedAt?: number;
}

/** Normalize a source record into Contrail's canonical mutation shape. */
export function createIngestEvent(input: RecordEventInput): IngestEvent {
  const deleted = input.operation === "delete";
  const serialized = deleted ? null : JSON.stringify(input.value);
  return {
    uri:
      input.uri ??
      `at://${input.did}/${input.collection}/${input.rkey}`,
    did: input.did,
    collection: input.collection,
    rkey: input.rkey,
    operation: input.operation,
    cid: deleted ? null : (input.cid ?? null),
    record: serialized ?? null,
    time_us: input.timeUs,
    indexed_at: input.indexedAt ?? Date.now() * 1000,
  };
}

export interface IngestRecordsOptions {
  skipReplayDetection?: boolean;
  skipFeedFanout?: boolean;
  /** Pre-fetched rows, used by immediate synchronization. */
  existing?: Map<string, ExistingRecordInfo>;
  phase?: "live" | "backfill";
  /** Known actors used to filter dependent records without another DB read. */
  knownDids?: ReadonlySet<string>;
}

export interface IngestDropCounts {
  unknownCollection: number;
  invalidRecord: number;
  recordFilter: number;
  unknownSubject: number;
}

export interface IngestRecordsResult {
  accepted: IngestEvent[];
  dropped: IngestDropCounts;
}

/**
 * The single admission and projection path for records from every source.
 *
 * Jetstream, persistent subscriptions, PDS backfill, refresh, and immediate
 * synchronization all produce the same IngestEvent shape and enter here.
 * Source connection and checkpoint handling remain outside this function.
 */
export async function ingestRecords(
  db: Database,
  events: IngestEvent[],
  config: ContrailConfig,
  options: IngestRecordsOptions = {},
): Promise<IngestRecordsResult> {
  const accepted: IngestEvent[] = [];
  const dropped: IngestDropCounts = {
    unknownCollection: 0,
    invalidRecord: 0,
    recordFilter: 0,
    unknownSubject: 0,
  };
  const logger = config.logger ?? console;

  for (const event of events) {
    const shortName = resolveCollectionKey(config, event.collection);
    if (!shortName) {
      dropped.unknownCollection++;
      logger.warn(
        `[ingest] drop unknown collection: ${event.operation} ${event.uri} collection=${event.collection}`,
      );
      continue;
    }

    if (event.operation !== "delete") {
      const record = parseRecord(event.record);
      if (!record) {
        dropped.invalidRecord++;
        logger.warn(`[ingest] drop invalid record: ${event.uri}`);
        continue;
      }

      const filter = config.collections[shortName]?.recordFilter;
      if (filter) {
        let keep = false;
        try {
          keep = filter(record);
        } catch (error) {
          logger.warn(`[ingest] recordFilter threw for ${event.uri}: ${error}`);
        }
        if (!keep) {
          dropped.recordFilter++;
          continue;
        }
      }
    }

    accepted.push(event);
  }

  const subjectFiltered = await filterUnknownSubjects(
    db,
    config,
    accepted,
    options.knownDids,
    dropped,
  );

  if (subjectFiltered.length > 0) {
    await projectEvents(db, subjectFiltered, config, options);
  }

  return { accepted: subjectFiltered, dropped };
}

async function filterUnknownSubjects(
  db: Database,
  config: ContrailConfig,
  events: IngestEvent[],
  knownDids: ReadonlySet<string> | undefined,
  dropped: IngestDropCounts,
): Promise<IngestEvent[]> {
  const subjectsByUri = new Map<string, string>();
  const subjects = new Set<string>();

  for (const event of events) {
    if (event.operation === "delete") continue;
    const shortName = resolveCollectionKey(config, event.collection);
    const subjectField = shortName
      ? config.collections[shortName]?.subjectField
      : undefined;
    if (!subjectField) continue;

    const record = parseRecord(event.record);
    const subject = record ? getNestedValue(record, subjectField) : undefined;
    if (typeof subject !== "string" || !isDid(subject)) {
      dropped.unknownSubject++;
      subjectsByUri.set(event.uri, "");
      continue;
    }
    subjectsByUri.set(event.uri, subject);
    subjects.add(subject);
  }

  if (subjectsByUri.size === 0) return events;

  const known = knownDids ? new Set(knownDids) : await loadKnownDids(db, subjects);
  return events.filter((event) => {
    const subject = subjectsByUri.get(event.uri);
    if (subject === undefined) return true;
    if (subject !== "" && known.has(subject)) return true;
    if (subject !== "") dropped.unknownSubject++;
    return false;
  });
}

async function loadKnownDids(
  db: Database,
  dids: Set<string>,
): Promise<Set<string>> {
  const known = new Set<string>();
  const list = [...dids];
  for (let index = 0; index < list.length; index += 100) {
    const chunk = list.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT did FROM identities WHERE did IN (${placeholders})`)
      .bind(...chunk)
      .all<{ did: string }>();
    for (const row of rows.results ?? []) known.add(row.did);
  }
  return known;
}

function parseRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
