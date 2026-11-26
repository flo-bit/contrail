import type { JetstreamLiveEvent } from "./jetstream-live";
import type {
  ContrailConfig,
  Database,
  IngestEvent,
  Statement,
} from "./types";
import {
  assertJetstreamServiceCompatibility,
  assertServingSourceCompatibility,
  initSchema,
  saveJetstreamCursorStatement,
  saveOrderedSourcePositionStatement,
} from "./db";
import { createIngestEvent, recordTimeUs } from "./ingest";
import { applyIdentityEventStatement } from "./identity";
import type { AccountUpdate } from "./moderation";

type JetstreamCommitEvent = Extract<JetstreamLiveEvent, { kind: "commit" }>;

/** Ensure schema and source compatibility before live Jetstream ingestion. */
export async function prepareLiveIngestSession(
  db: Database,
  config: ContrailConfig,
  service: string,
  state: { schemaInitialized: boolean },
): Promise<void> {
  if (!state.schemaInitialized) {
    await initSchema(db, config);
    state.schemaInitialized = true;
  }
  await assertServingSourceCompatibility(db, config.orderedSource);
  await assertJetstreamServiceCompatibility(db, service);
}

/** Keep only the newest account lifecycle update per actor by cursor.
 * Returns true if the map was updated. */
export function upsertAccountUpdate(
  map: Map<string, AccountUpdate>,
  update: AccountUpdate,
): boolean {
  const prior = map.get(update.did);
  if (prior && prior.cursor >= update.cursor) return false;
  map.delete(update.did);
  map.set(update.did, update);
  return true;
}

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

/** Statements that atomically advance the Jetstream v2 cursor and optional
 * `orderedSource` position in a single batch. */
export function jetstreamCheckpointStatements(
  db: Database,
  config: ContrailConfig,
  cursor: number,
): Statement[] {
  return [
    saveJetstreamCursorStatement(db, cursor),
    ...(config.orderedSource
      ? [saveOrderedSourcePositionStatement(db, config.orderedSource, cursor)]
      : []),
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
