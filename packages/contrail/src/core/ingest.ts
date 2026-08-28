import { isDid } from "@atcute/lexicons/syntax";
import type {
  ContrailConfig,
  Database,
  IngestEvent,
  MutationSource,
  ProjectionPhase,
  Statement,
} from "./types";
import {
  getNestedValue,
  resolveCollectionKey,
} from "./types";
import {
  isProjectionConflictError,
  lookupRecordVersions,
  projectEvents,
  selectAuthoritativeMutations,
  selectMutationWinners,
  type ExistingRecordInfo,
} from "./db/records";
import {
  addIngestDiagnosticCounts,
  ingestDiagnosticsStatement,
  type IngestDiagnosticCounts,
} from "./diagnostics";
import {
  validateCanonicalRecord,
  type RecordValidationFailure,
} from "./validation";

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
      ...(input.source?.epoch === undefined
        ? {}
        : { epoch: input.source.epoch }),
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
  /** Known actors used to filter dependent records without another DB read. */
  knownDids?: ReadonlySet<string>;
  /** Statements committed after projection in the same database batch. */
  trailingStatements?: Statement[];
  /** The source response is a current authoritative snapshot, so it supersedes
   * durable observations without a redundant version lookup. */
  authoritativeSourceObservation?: boolean;
  /** Acquisition phase for optional durable consumers. Defaults to live for
   * backwards-compatible direct ingestRecords() calls. */
  phase?: ProjectionPhase;
  /** @internal Aggregate private diagnostics for one bulk run. The caller
   * flushes this bounded object once after concurrent page processing. */
  aggregateDiagnostics?: IngestDiagnosticCounts;
}

export interface IngestDropCounts {
  unknownCollection: number;
  invalidRecord: number;
  lexiconValidation: number;
  cidMismatch: number;
  cidEncoding: number;
  missingCid: number;
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
    lexiconValidation: 0,
    cidMismatch: 0,
    cidEncoding: 0,
    missingCid: 0,
    recordFilter: 0,
    unknownActor: 0,
    unknownSubject: 0,
    superseded: 0,
  };
  const logger = config.logger ?? console;
  let candidates: Array<{
    event: IngestEvent;
    shortName: string;
    record: Record<string, unknown> | null;
  }> = [];

  for (const event of events) {
    const shortName = resolveCollectionKey(config, event.collection);
    if (!shortName) {
      dropped.unknownCollection++;
      logger.warn(
        `[ingest] drop unknown collection: ${event.operation} ${event.uri} collection=${event.collection}`,
      );
      continue;
    }
    const record =
      event.operation === "delete" ? null : parseRecord(event.record);
    if (event.operation !== "delete" && !record) {
      dropped.invalidRecord++;
      logger.warn(`[ingest] drop invalid record: ${event.uri}`);
      continue;
    }
    candidates.push({ event, shortName, record });
  }

  // A backfill page contains one collection. When that collection is dependent
  // and the caller supplied the complete actor set, reject out-of-scope rows
  // before expensive Lexicon/CID work. Mixed live batches keep the two-pass path
  // below so a discoverable record can still admit a dependent sibling.
  const hasDiscoverableMutation = candidates.some(({ event, shortName }) => {
    const collection = config.collections[shortName];
    return event.operation !== "delete" && collection?.discover !== false;
  });
  if (options.knownDids && !hasDiscoverableMutation) {
    candidates = candidates.filter(({ event, shortName, record }) => {
      if (event.operation === "delete") return true;
      const collection = config.collections[shortName];
      if (collection?.discover !== false) return true;
      if (!options.knownDids!.has(event.did)) {
        dropped.unknownActor++;
        return false;
      }
      if (!collection.subjectField) return true;
      const subject = record
        ? getNestedValue(record, collection.subjectField)
        : undefined;
      if (typeof subject !== "string" || !isDid(subject)) {
        dropped.unknownSubject++;
        return false;
      }
      if (!options.knownDids!.has(subject)) {
        dropped.unknownSubject++;
        return false;
      }
      return true;
    });
  }

  // CID hashing is asynchronous. Validate a bounded ingest batch in parallel,
  // while preserving source order when applying admission decisions below.
  const validationFailures = await Promise.all(
    candidates.map(({ event, record }) =>
      record ? validateCanonicalRecord(config, event, record) : null,
    ),
  );

  for (let index = 0; index < candidates.length; index++) {
    const { event, shortName, record } = candidates[index];
    const failure = validationFailures[index];
    if (failure) {
      incrementValidationDrop(dropped, failure);
      continue;
    }

    if (record) {
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

  const validationDropTotal =
    dropped.lexiconValidation +
    dropped.cidMismatch +
    dropped.cidEncoding +
    dropped.missingCid;
  if (validationDropTotal > 0 && !options.aggregateDiagnostics) {
    logger.warn(
      `[ingest] dropped ${validationDropTotal} record(s) during validation ` +
        `(lexicon=${dropped.lexiconValidation}, cid_mismatch=${dropped.cidMismatch}, ` +
        `cid_encoding=${dropped.cidEncoding}, missing_cid=${dropped.missingCid})`,
    );
  }

  // Winner reads occur before db.batch on D1, so each projection carries the
  // exact predecessor tokens it observed. A concurrent projector changes a
  // token, the named transaction guard rolls everything back, and this loop
  // repeats selection plus derived-state reads from fresh durable state.
  const retryBase = {
    unknownActor: dropped.unknownActor,
    unknownSubject: dropped.unknownSubject,
    superseded: dropped.superseded,
  };
  const maximumAttempts = 5;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const attemptDropped: IngestDropCounts = {
      ...dropped,
      unknownActor: retryBase.unknownActor,
      unknownSubject: retryBase.unknownSubject,
      superseded: retryBase.superseded,
    };
    const predecessors = await lookupRecordVersions(
      db,
      accepted.map((event) => event.uri),
    );
    const ordered = options.authoritativeSourceObservation
      ? selectAuthoritativeMutations(accepted)
      : selectMutationWinners(accepted, predecessors);
    attemptDropped.superseded += ordered.superseded;

    const projectionExclusions = ordered.applied.filter((event) =>
      policyExcluded.has(event),
    );
    const admitted = ordered.applied.filter(
      (event) => !policyExcluded.has(event),
    );

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
      attemptDropped.unknownActor++;
    }

    const subjectFiltered = await filterUnknownSubjects(
      db,
      config,
      actorFiltered,
      effectiveKnownDids,
      attemptDropped,
    );
    const projectionEvents = [...subjectFiltered, ...projectionExclusions];
    const diagnosticCounts: IngestDiagnosticCounts = {
      unknown_collection: attemptDropped.unknownCollection,
      invalid_json: attemptDropped.invalidRecord,
      lexicon_validation: attemptDropped.lexiconValidation,
      cid_mismatch: attemptDropped.cidMismatch,
      cid_encoding: attemptDropped.cidEncoding,
      missing_cid: attemptDropped.missingCid,
      record_filter: attemptDropped.recordFilter,
      unknown_actor: attemptDropped.unknownActor,
      unknown_subject: attemptDropped.unknownSubject,
      superseded: attemptDropped.superseded,
    };
    const diagnostics = options.aggregateDiagnostics
      ? null
      : ingestDiagnosticsStatement(db, diagnosticCounts);
    const trailingStatements = [
      ...(diagnostics ? [diagnostics] : []),
      ...(options.trailingStatements ?? []),
    ];

    try {
      if (projectionEvents.length > 0) {
        await projectEvents(db, projectionEvents, config, {
          ...options,
          phase: options.phase ?? "live",
          // A pre-fetched visible-row map is not safe after a conflict; the
          // projector deliberately reloads it under this predecessor attempt.
          existing: undefined,
          trailingStatements,
          sourceOrderingChecked: true,
          predecessors,
        });
      } else if (trailingStatements.length > 0) {
        await db.batch(trailingStatements);
      }
    } catch (error) {
      if (isProjectionConflictError(error) && attempt < maximumAttempts) {
        continue;
      }
      throw error;
    }

    Object.assign(dropped, attemptDropped);
    // Aggregate only after the canonical projection/checkpoint transaction
    // succeeds, so a rolled-back attempt cannot inflate private diagnostics.
    if (options.aggregateDiagnostics) {
      addIngestDiagnosticCounts(options.aggregateDiagnostics, diagnosticCounts);
    }
    return { accepted: subjectFiltered, dropped, discoveredDids };
  }

  throw new Error("Projection conflict retry limit exhausted");
}

function incrementValidationDrop(
  dropped: IngestDropCounts,
  failure: RecordValidationFailure,
): void {
  if (failure === "lexicon_validation") dropped.lexiconValidation++;
  else if (failure === "cid_mismatch") dropped.cidMismatch++;
  else if (failure === "cid_encoding") dropped.cidEncoding++;
  else dropped.missingCid++;
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
): Promise<IngestEvent[]> {
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

  if (subjectsByEvent.size === 0) return events;

  const known = knownDids ? new Set(knownDids) : await loadKnownDids(db, subjects);
  const accepted: IngestEvent[] = [];
  for (const event of events) {
    const subject = subjectsByEvent.get(event);
    if (subject === undefined || (subject !== "" && known.has(subject))) {
      accepted.push(event);
      continue;
    }
    if (subject !== "") dropped.unknownSubject++;
  }
  return accepted;
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
