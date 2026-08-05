import { isDid } from "@atcute/lexicons/syntax";
import type {
  ContrailConfig,
  Database,
  IngestEvent,
  MutationSource,
  Statement,
} from "./types";
import {
  getNestedValue,
  resolveCollectionKey,
} from "./types";
import {
  projectEvents,
  selectCurrentMutations,
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
  /** Record/application time used by query and feed ordering. */
  timeUs: number;
  indexedAt?: number;
  /** Source ordering metadata. Defaults to a local observation. */
  source?: Partial<MutationSource> & Pick<MutationSource, "id">;
}

/** Normalize a source record into Contrail's canonical mutation shape. */
export function createIngestEvent(input: RecordEventInput): IngestEvent {
  const deleted = input.operation === "delete";
  const serialized = deleted ? null : JSON.stringify(input.value);
  const indexedAt = input.indexedAt ?? Date.now() * 1000;
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
    indexed_at: indexedAt,
    source: {
      id: input.source?.id ?? "local",
      // Preserve pre-0.13.1 ordering for callers that do not yet provide a
      // separate source clock; adapters always pass source.time_us explicitly.
      time_us: input.source?.time_us ?? input.timeUs,
      revision: input.source?.revision ?? null,
      cursor: input.source?.cursor ?? null,
    },
  };
}

const DEFAULT_TIME_FIELD = "createdAt";

/**
 * Parse a record's configured application time independently of source order.
 * Missing, invalid, and future values fall back to the source observation time.
 */
export function recordTimeUs(
  record: unknown,
  collection: string,
  config: ContrailConfig,
  fallbackUs: number,
): number {
  const short = resolveCollectionKey(config, collection);
  const collectionConfig = short ? config.collections[short] : undefined;
  const field = collectionConfig?.timeField ?? DEFAULT_TIME_FIELD;
  if (field === false) return fallbackUs;
  const raw =
    record && typeof record === "object"
      ? (record as Record<string, unknown>)[field]
      : undefined;
  if (typeof raw !== "string") return fallbackUs;
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return fallbackUs;
  const microseconds = milliseconds * 1000;
  return microseconds > fallbackUs ? fallbackUs : microseconds;
}

export interface IngestRecordsOptions {
  skipReplayDetection?: boolean;
  skipFeedFanout?: boolean;
  /** Skip FTS and relation-count maintenance for a bulk load that will rebuild
   * both projections once canonical records are durable. */
  skipDerivedProjections?: boolean;
  /** Pre-fetched rows, used by immediate synchronization. */
  existing?: Map<string, ExistingRecordInfo>;
  phase?: "live" | "backfill";
  /** Known actors used to filter dependent records without another DB read. */
  knownDids?: ReadonlySet<string>;
  /** Statements committed after projection in the same database batch. */
  trailingStatements?: Statement[];
}

export interface IngestDropCounts {
  unknownCollection: number;
  invalidRecord: number;
  recordFilter: number;
  unknownActor: number;
  unknownSubject: number;
  /** Duplicate or stale mutations rejected by durable source ordering. */
  superseded: number;
}

export interface IngestRecordsResult {
  accepted: IngestEvent[];
  dropped: IngestDropCounts;
  /** Discoverable actors admitted by this batch but absent from knownDids. */
  discoveredDids: string[];
}

/**
 * The single admission and projection path for records from every source.
 *
 * Jetstream, persistent subscriptions, PDS backfill, and immediate
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
  const policyExcluded = new Set<IngestEvent>();
  const dropped: IngestDropCounts = {
    unknownCollection: 0,
    invalidRecord: 0,
    recordFilter: 0,
    unknownActor: 0,
    unknownSubject: 0,
    superseded: 0,
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
          const exclusion = asProjectionDelete(event);
          accepted.push(exclusion);
          policyExcluded.add(exclusion);
          continue;
        }
      }
    }

    accepted.push(event);
  }

  // Reject duplicate/stale source observations before they can admit dependent
  // actors in this batch. The winning versions are persisted with projection.
  const ordered = await selectCurrentMutations(db, accepted);
  dropped.superseded += ordered.superseded;

  const projectionExclusions = ordered.applied.filter((event) =>
    policyExcluded.has(event),
  );
  const admitted = ordered.applied.filter((event) => !policyExcluded.has(event));

  const effectiveKnownDids = options.knownDids
    ? new Set(options.knownDids)
    : undefined;
  const discoveredDids: string[] = [];
  if (effectiveKnownDids) {
    for (const event of admitted) {
      if (event.operation === "delete") continue;
      const shortName = resolveCollectionKey(config, event.collection);
      const collection = shortName ? config.collections[shortName] : undefined;
      if (collection?.discover === false || effectiveKnownDids.has(event.did)) {
        continue;
      }
      effectiveKnownDids.add(event.did);
      discoveredDids.push(event.did);
    }
  }

  const actorFiltered: IngestEvent[] = [];
  for (const event of admitted) {
    if (event.operation === "delete" || !effectiveKnownDids) {
      actorFiltered.push(event);
      continue;
    }
    const shortName = resolveCollectionKey(config, event.collection);
    const collection = shortName ? config.collections[shortName] : undefined;
    if (collection?.discover !== false || effectiveKnownDids.has(event.did)) {
      actorFiltered.push(event);
      continue;
    }
    dropped.unknownActor++;
    projectionExclusions.push(asProjectionDelete(event));
  }

  const subjectResult = await filterUnknownSubjects(
    db,
    config,
    actorFiltered,
    effectiveKnownDids,
    dropped,
  );
  projectionExclusions.push(...subjectResult.excluded);

  const projectionEvents = [
    ...subjectResult.accepted,
    ...projectionExclusions,
  ];
  if (projectionEvents.length > 0) {
    await projectEvents(db, projectionEvents, config, {
      ...options,
      sourceOrderingChecked: true,
    });
  } else if (options.trailingStatements?.length) {
    await db.batch(options.trailingStatements);
  }

  return { accepted: subjectResult.accepted, dropped, discoveredDids };
}

function asProjectionDelete(event: IngestEvent): IngestEvent {
  return {
    ...event,
    operation: "delete",
    // Policy exclusions retain the authoritative source CID in the tombstone.
    // True source deletes still enter with a null CID.
    cid: event.cid,
    record: null,
  };
}

async function filterUnknownSubjects(
  db: Database,
  config: ContrailConfig,
  events: IngestEvent[],
  knownDids: ReadonlySet<string> | undefined,
  dropped: IngestDropCounts,
): Promise<{ accepted: IngestEvent[]; excluded: IngestEvent[] }> {
  const subjectsByEvent = new Map<IngestEvent, string>();
  const subjects = new Set<string>();

  for (const event of events) {
    if (event.operation === "delete") continue;
    const shortName = resolveCollectionKey(config, event.collection);
    const collection = shortName ? config.collections[shortName] : undefined;
    const subjectField =
      collection?.discover === false ? collection.subjectField : undefined;
    if (!subjectField) continue;

    const record = parseRecord(event.record);
    const subject = record ? getNestedValue(record, subjectField) : undefined;
    if (typeof subject !== "string" || !isDid(subject)) {
      dropped.unknownSubject++;
      subjectsByEvent.set(event, "");
      continue;
    }
    subjectsByEvent.set(event, subject);
    subjects.add(subject);
  }

  if (subjectsByEvent.size === 0) {
    return { accepted: events, excluded: [] };
  }

  const known = knownDids ? new Set(knownDids) : await loadKnownDids(db, subjects);
  const accepted: IngestEvent[] = [];
  const excluded: IngestEvent[] = [];
  for (const event of events) {
    const subject = subjectsByEvent.get(event);
    if (subject === undefined || (subject !== "" && known.has(subject))) {
      accepted.push(event);
      continue;
    }
    if (subject !== "") dropped.unknownSubject++;
    excluded.push(asProjectionDelete(event));
  }
  return { accepted, excluded };
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
