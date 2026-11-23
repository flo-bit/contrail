import type { JetstreamLiveEvent } from "./jetstream-live";
import type {
  ContrailConfig,
  Database,
  IngestEvent,
  Statement,
} from "./types";
import {
  saveJetstreamCursorObservationStatements,
  saveJetstreamCursorStatement,
  saveOrderedSourcePositionStatement,
} from "./db";
import { createIngestEvent, recordTimeUs } from "./ingest";
import { applyIdentityEventStatement } from "./identity";

type JetstreamCommitEvent = Extract<JetstreamLiveEvent, { kind: "commit" }>;

/** Normalize one live Jetstream v2 commit event into Contrail's canonical
 * `IngestEvent` shape. Shared by scheduled (`jetstream.ts`) and long-lived
 * (`persistent.ts`) ingestion loops. */
export function commitToIngestEvent(
  event: JetstreamCommitEvent,
  config: ContrailConfig,
  sourceId: string,
  sourceEpoch: string | null,
): IngestEvent {
  const { commit } = event;
  return createIngestEvent({
    did: event.did,
    timeUs:
      commit.operation === "delete"
        ? event.time_us
        : recordTimeUs(commit.record, commit.collection, config, event.time_us),
    collection: commit.collection,
    operation: commit.operation,
    rkey: commit.rkey,
    cid: commit.operation === "delete" ? null : commit.cid,
    value: commit.operation === "delete" ? undefined : commit.record,
    source: {
      id: sourceId,
      ...(sourceEpoch === null ? {} : { epoch: sourceEpoch }),
      time_us: event.time_us,
      revision: commit.rev,
      cursor: String(event.seq),
    },
  });
}

/** Statements that atomically advance the Jetstream v2 cursor, optional
 * `orderedSource` position, and cursor observations in a single batch. */
export function jetstreamCheckpointStatements(
  db: Database,
  config: ContrailConfig,
  cursor: number,
  cursorObservations: Iterable<string> = [],
): Statement[] {
  return [
    saveJetstreamCursorStatement(db, cursor),
    ...(config.orderedSource
      ? [saveOrderedSourcePositionStatement(db, config.orderedSource, cursor)]
      : []),
    ...saveJetstreamCursorObservationStatements(db, cursor, cursorObservations),
  ];
}

/** Flush buffered handle updates in bounded `db.batch()` chunks. Returns how
 * many chunks committed cleanly; per-chunk errors are forwarded to `onError`
 * rather than aborting forward progress. */
export async function flushIdentityUpdates(
  db: Database,
  entries: ReadonlyArray<[string, string]>,
  batchSize: number,
  onError: (chunk: ReadonlyArray<[string, string]>, error: unknown) => void,
): Promise<number> {
  let committed = 0;
  for (let index = 0; index < entries.length; index += batchSize) {
    const chunk = entries.slice(index, index + batchSize);
    try {
      const updatedAt = Date.now();
      await db.batch(
        chunk.map(([did, handle]) =>
          applyIdentityEventStatement(db, did, handle, updatedAt),
        ),
      );
      committed++;
    } catch (error) {
      onError(chunk, error);
    }
  }
  return committed;
}
