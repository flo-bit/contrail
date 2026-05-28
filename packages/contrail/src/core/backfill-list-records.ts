/**
 * Paginated `com.atproto.repo.listRecords` backfill — the default strategy.
 *
 * One request per (did, collection) page; cursor stored in `backfills.pds_cursor`
 * so a partial walk can resume next cycle. Slower than the CAR path
 * (`./backfill-car.ts`) but lets you cap bandwidth per collection.
 */
import { type Did } from "@atcute/lexicons";
import { isDid, isNsid } from "@atcute/lexicons/syntax";

import type { Client } from "@atcute/client";
import type { ContrailConfig, Database, IngestEvent } from "./types";
import { applyEvents } from "./db";
import { getClient } from "./client";
import { recordTimeUs, filterEventsBySubject } from "./backfill-shared";

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

export interface BackfillListRecordsOptions {
  /** Pre-resolved client — avoids redundant PDS lookups when batching by DID. */
  client?: Client;
  /** Skip replay detection in applyEvents (safe during initial backfill). */
  skipReplayDetection?: boolean;
  /** Max retries per request (default: 3). Set to 0 for single-attempt mode. */
  maxRetries?: number;
  /** Per-request timeout in ms (default: 10000). */
  requestTimeout?: number;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs)
        ),
      ]);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function markFailed(
  db: Database,
  did: string,
  collection: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE backfills SET retries = retries + 1, last_error = ? WHERE did = ? AND collection = ?"
    )
    .bind(error, did, collection)
    .run();
}

export async function backfillUserListRecords(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config: ContrailConfig | undefined,
  options?: BackfillListRecordsOptions
): Promise<number> {
  if (Date.now() >= deadline) return 0;

  const status = await db
    .prepare(
      "SELECT completed, pds_cursor, retries FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ completed: number; pds_cursor: string | null; retries: number }>();

  if (status?.completed) return 0;

  if (!status) {
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
      )
      .bind(did, collection)
      .run();
  }

  let currentCursor: string | undefined = status?.pds_cursor ?? undefined;
  const retries = options?.maxRetries ?? 3;
  const timeout = options?.requestTimeout ?? REQUEST_TIMEOUT_MS;

  if (!isDid(did)) {
    await markFailed(db, did, collection, `Invalid DID: ${did}`);
    return 0;
  }

  if (!isNsid(collection)) {
    await markFailed(db, did, collection, `Invalid NSID: ${collection}`);
    return 0;
  }

  let client = options?.client;
  if (!client) {
    try {
      client = await withRetry(
        () => getClient(did as Did, db),
        `getClient(${did})`,
        Math.min(retries, 1),
        timeout
      );
    } catch (err) {
      await markFailed(db, did, collection, String(err));
      return 0;
    }
  }

  let totalInserted = 0;
  let done = false;

  // If this collection declares a subjectField, we drop records whose subject
  // DID isn't already in our identities table (lookup happens once per page).
  const colConfig = config
    ? Object.values(config.collections).find((c) => c.collection === collection)
    : undefined;
  const subjectField = colConfig?.subjectField;

  try {
    while (Date.now() < deadline) {
      const response = await withRetry(
        () =>
          client!.get("com.atproto.repo.listRecords", {
            params: {
              repo: did as Did,
              collection,
              limit: PAGE_SIZE,
              cursor: currentCursor,
            },
          }),
        `listRecords(${did}/${collection})`,
        retries,
        timeout
      );
      if (!response.ok) {
        await markFailed(
          db,
          did,
          collection,
          `listRecords status ${response.status}`
        );
        return totalInserted;
      }

      if (response.data.records.length === 0) {
        done = true;
        break;
      }

      const now = Date.now();
      const nowUs = now * 1000;
      let events: IngestEvent[] = response.data.records.map((r) => ({
        uri: r.uri,
        did,
        collection,
        rkey: r.uri.split("/").pop()!,
        operation: "create" as const,
        cid: r.cid,
        record: JSON.stringify(r.value),
        time_us: recordTimeUs(r.value, collection, config, nowUs),
        indexed_at: nowUs,
      }));

      if (subjectField) {
        events = await filterEventsBySubject(db, events, subjectField);
      }

      if (events.length > 0) {
        await applyEvents(db, events, config, {
          skipReplayDetection: options?.skipReplayDetection,
          skipFeedFanout: true,
        });
      }
      totalInserted += events.length;

      currentCursor = response.data.cursor ?? undefined;

      await db
        .prepare(
          "UPDATE backfills SET pds_cursor = ? WHERE did = ? AND collection = ?"
        )
        .bind(currentCursor ?? null, did, collection)
        .run();

      if (!currentCursor) {
        done = true;
        break;
      }
    }
  } catch (err) {
    await markFailed(db, did, collection, String(err));
    return totalInserted;
  }

  if (done) {
    await db
      .prepare(
        "UPDATE backfills SET completed = 1 WHERE did = ? AND collection = ?"
      )
      .bind(did, collection)
      .run();
  }

  return totalInserted;
}
