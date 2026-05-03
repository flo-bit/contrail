/** Record-host sync endpoint — streams record events for a specific space.
 *
 *  Two phases per connection:
 *    1. **Catch-up**: scan the per-collection `spaces_records_<short>` tables
 *       for `time_us > since`, emit each row as `record.created`. After each
 *       batch, emit a `cursor` checkpoint so the client can persist progress.
 *    2. **Live**: subscribe to the in-process pubsub for `space:<uri>` and
 *       forward record.created / record.deleted events.
 *
 *  Phase 7b MVP limitations:
 *    - Catch-up only sees `record.created`; deletions in the past aren't
 *      replayed (the row is gone). Live deletions are emitted.
 *    - Brief race between catch-up end and live subscribe — if a write
 *      lands in that window, the next reconnect catches it via catch-up.
 *    - SSE only (no WS). Simpler. WS can be added if needed.
 *
 *  Auth: requires a valid X-Space-Credential whose `space` claim matches
 *  the requested spaceUri and whose scope is `read` or `rw`. */

import type { Hono, MiddlewareHandler } from "hono";
import type {
  ContrailConfig,
  CredentialClaims,
  CredentialVerifier,
  PubSub,
  RealtimeEvent,
  RecordHost,
} from "@atmo-dev/contrail-base";
import {
  DEFAULT_KEEPALIVE_MS,
  extractSpaceCredential,
  shortNameForNsid,
  spacesRecordsTableName,
  spaceTopic,
} from "@atmo-dev/contrail-base";
import type { Database } from "@atmo-dev/contrail-base";

/** Events emitted on the wire. RealtimeEvent kinds (record.created /
 *  record.deleted) plus our own `cursor` checkpoint. */
export type SyncEvent =
  | RealtimeEvent
  | { kind: "cursor"; value: string };

export interface RecordHostSyncOptions {
  /** Database the host's record tables live on. */
  db: Database;
  /** Optional pubsub for live mode. When omitted, sync is catch-up only —
   *  the stream ends after catch-up rather than tailing for new writes. */
  pubsub?: PubSub | null;
  /** Required: verifier for the X-Space-Credential header. */
  credentialVerifier: CredentialVerifier;
  /** Page size for catch-up scans. Default 100. */
  batchSize?: number;
  /** SSE keepalive interval in ms. Default uses the realtime module's. */
  keepaliveMs?: number;
}

export function registerRecordHostSyncRoutes(
  app: Hono,
  recordHost: RecordHost,
  config: ContrailConfig,
  options: RecordHostSyncOptions
): void {
  const RECORD_HOST = `${config.namespace}.recordHost`;
  const batchSize = options.batchSize ?? 100;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

  app.get(`/xrpc/${RECORD_HOST}.sync`, async (c) => {
    // ---- Auth: credential required ----
    const credToken = extractSpaceCredential(c.req.raw);
    if (!credToken) {
      return c.json(
        { error: "AuthRequired", reason: "credential-required" },
        401
      );
    }
    const verified = await options.credentialVerifier.verify(credToken);
    if (!verified.ok) {
      return c.json({ error: "AuthRequired", reason: verified.reason }, 401);
    }
    const claims = verified.claims;

    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) {
      return c.json(
        { error: "InvalidRequest", message: "spaceUri required" },
        400
      );
    }
    if (claims.space !== spaceUri) {
      return c.json(
        { error: "Forbidden", reason: "credential-wrong-space" },
        403
      );
    }

    const enrollment = await recordHost.getEnrollment(spaceUri);
    if (!enrollment) {
      return c.json(
        { error: "NotFound", reason: "not-enrolled" },
        404
      );
    }

    const since = parseSince(c.req.query("since"));

    // Build the SSE response with a hand-rolled stream so we can interleave
    // catch-up batches and live events under one cursor sequence.
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };
        ac.signal.addEventListener("abort", close, { once: true });

        const keepalive = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`: keepalive\n\n`));
          } catch {
            close();
          }
        }, keepaliveMs);

        const writeEvent = (e: SyncEvent) => {
          if (closed) return false;
          try {
            controller.enqueue(enc.encode(frameEvent(e)));
            return true;
          } catch {
            close();
            return false;
          }
        };

        try {
          controller.enqueue(enc.encode(`: open\n\n`));

          // ---- Phase 1: catch-up ----
          const lastCursor = await streamCatchup({
            db: options.db,
            config,
            spaceUri,
            since,
            batchSize,
            writeEvent,
            isClosed: () => closed,
          });
          if (closed) return;

          // ---- Phase 2: live ----
          if (options.pubsub) {
            const liveCutoff = lastCursor ?? since;
            for await (const event of options.pubsub.subscribe(
              spaceTopic(spaceUri),
              ac.signal
            )) {
              if (closed) break;
              // Ignore events older than what catch-up already covered.
              const ts = (event as any).payload?.time_us ?? null;
              if (
                liveCutoff != null &&
                typeof ts === "number" &&
                ts <= liveCutoff
              ) {
                continue;
              }
              if (
                event.kind !== "record.created" &&
                event.kind !== "record.deleted"
              ) {
                continue;
              }
              const ok = writeEvent(event);
              if (!ok) break;
              // Emit a cursor checkpoint after each live event so consumers
              // can resume from the latest seen point.
              if (typeof ts === "number") {
                writeEvent({ kind: "cursor", value: String(ts) });
              }
            }
          }
        } catch (err) {
          if (!closed) {
            try {
              controller.enqueue(
                enc.encode(
                  `event: error\ndata: ${JSON.stringify({
                    message: err instanceof Error ? err.message : String(err),
                  })}\n\n`
                )
              );
            } catch {
              /* already torn down */
            }
          }
        } finally {
          clearInterval(keepalive);
          close();
        }
      },
      cancel() {
        ac.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}

/** Catch-up phase: scan every configured per-collection spaces_records table
 *  for rows with `time_us > since`, emit them in time_us order. Returns the
 *  highest time_us emitted (or null if nothing emitted). */
async function streamCatchup(args: {
  db: Database;
  config: ContrailConfig;
  spaceUri: string;
  since: number | null;
  batchSize: number;
  writeEvent: (e: SyncEvent) => boolean;
  isClosed: () => boolean;
}): Promise<number | null> {
  const { db, config, spaceUri, since, batchSize, writeEvent, isClosed } = args;
  let highest = since;

  for (const [_short, colCfg] of Object.entries(config.collections)) {
    if (colCfg.allowInSpaces === false) continue;
    if (isClosed()) return highest;

    const collectionNsid = colCfg.collection;
    const short = shortNameForNsid(config, collectionNsid);
    if (!short) continue;
    const table = spacesRecordsTableName(short);

    let cursor = since;
    while (true) {
      if (isClosed()) return highest;

      let rows: any[];
      try {
        const sql =
          cursor != null
            ? `SELECT * FROM ${table} WHERE space_uri = ? AND time_us > ? ORDER BY time_us LIMIT ?`
            : `SELECT * FROM ${table} WHERE space_uri = ? ORDER BY time_us LIMIT ?`;
        const result = await (cursor != null
          ? db.prepare(sql).bind(spaceUri, cursor, batchSize).all<any>()
          : db.prepare(sql).bind(spaceUri, batchSize).all<any>());
        rows = result.results;
      } catch {
        // Table missing — skip this collection silently.
        break;
      }

      if (rows.length === 0) break;

      for (const row of rows) {
        if (isClosed()) return highest;
        const time_us = numericish(row.time_us);
        const event: RealtimeEvent = {
          topic: spaceTopic(spaceUri),
          kind: "record.created",
          payload: {
            uri: row.uri,
            did: row.did,
            collection: collectionNsid,
            rkey: row.rkey,
            cid: row.cid ?? null,
            record: parseRecordJson(row.record),
            time_us,
            space: spaceUri,
          },
          ts: Date.now(),
        };
        if (!writeEvent(event)) return highest;
        if (highest == null || time_us > highest) highest = time_us;
        cursor = time_us;
      }

      // Cursor checkpoint after the batch.
      if (highest != null) {
        writeEvent({ kind: "cursor", value: String(highest) });
      }

      if (rows.length < batchSize) break;
    }
  }

  return highest;
}

function frameEvent(event: SyncEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseSince(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isNaN(n) || !Number.isFinite(n)) return null;
  return n;
}

function numericish(v: unknown): number {
  return typeof v === "string" ? Number(v) : (v as number);
}

function parseRecordJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}
