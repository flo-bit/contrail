/** Appview-side ingestion loop for the recordHost.sync streaming endpoint.
 *
 *  Opens an SSE connection to a remote host's `<ns>.recordHost.sync` endpoint
 *  for a (host, space) pair, parses the event stream, writes each
 *  `record.created` / `record.deleted` event into the local record host's
 *  tables, and persists the cursor after every checkpoint.
 *
 *  Designed to be called per-subscription. Reconnect logic is the caller's —
 *  this function returns when the stream ends or an error throws. Wrap it in
 *  a retry-with-backoff loop in your worker / persistent-process. */

import type {
  ContrailConfig,
  Database,
  RecordHost,
  SqlDialect,
} from "@atmo-dev/contrail-base";
import { getDialect } from "@atmo-dev/contrail-base";

export interface RecordHostSyncSource {
  /** Remote host's base URL, e.g. "https://contrail-a.example.com". */
  hostUrl: string;
  /** Space we want to sync. */
  spaceUri: string;
  /** Authority DID — used for auto-enrolling locally on first connect. */
  authorityDid: string;
  /** Credential the appview presents to read this space's stream. */
  credential: string;
  /** Sync endpoint NSID; defaults to "<config.namespace>.recordHost.sync". */
  endpointNsid?: string;
}

export interface RecordHostSyncOptions {
  /** Local DB the records go into (same DB the appview's RecordHost adapter uses). */
  db: Database;
  /** Resolved config. Used to derive the remote endpoint NSID and to find
   *  collection short names for table writes. */
  config: ContrailConfig;
  /** Local record host — the destination for ingested events. The function
   *  calls `putRecord` / `deleteRecord` / `enroll` on this. */
  recordHost: RecordHost;
  /** fetch implementation — pass the remote host app's fetch directly for
   *  in-process tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Aborts the stream when triggered. */
  signal?: AbortSignal;
  /** Called on each cursor checkpoint, after persistence. */
  onCursor?: (cursor: string) => void;
}

/** Run sync for a single (host, space) source until the stream ends or the
 *  signal aborts. Reads the prior cursor from `record_sync_subscriptions` if
 *  present; persists the new cursor as it advances. Auto-enrolls the space
 *  locally on first connect using the source's `authorityDid`. */
export async function runRecordHostSync(
  source: RecordHostSyncSource,
  options: RecordHostSyncOptions
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  await ensureSyncSchema(options.db);

  // Auto-enroll the space so the local record host accepts subsequent
  // queries against it.
  const existing = await options.recordHost.getEnrollment(source.spaceUri);
  if (!existing) {
    await options.recordHost.enroll({
      spaceUri: source.spaceUri,
      authorityDid: source.authorityDid,
      enrolledAt: Date.now(),
      enrolledBy: source.authorityDid,
    });
  }

  // Resume from the last persisted cursor for this subscription.
  const since = await readCursor(options.db, source.hostUrl, source.spaceUri);

  const endpoint =
    source.endpointNsid ?? `${options.config.namespace}.recordHost.sync`;
  const url = new URL(`${source.hostUrl}/xrpc/${endpoint}`);
  url.searchParams.set("spaceUri", source.spaceUri);
  if (since) url.searchParams.set("since", since);

  const res = await fetchImpl(url.toString(), {
    headers: {
      "X-Space-Credential": source.credential,
      accept: "text/event-stream",
    },
    signal: options.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`recordHost.sync ${res.status}: ${body}`);
  }
  if (!res.body) {
    throw new Error("recordHost.sync response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buf.indexOf("\n\n");
        if (idx < 0) break;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        let event: any;
        try {
          event = JSON.parse(json);
        } catch {
          continue;
        }
        await applyEvent(event, options);
        if (event.kind === "cursor" && typeof event.value === "string") {
          await persistCursor(
            options.db,
            source.hostUrl,
            source.spaceUri,
            event.value
          );
          options.onCursor?.(event.value);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function applyEvent(
  event: any,
  options: RecordHostSyncOptions
): Promise<void> {
  if (event.kind === "record.created") {
    const p = event.payload;
    await options.recordHost.putRecord({
      spaceUri: p.space,
      collection: p.collection,
      authorDid: p.did,
      rkey: p.rkey,
      cid: p.cid ?? null,
      record: p.record ?? {},
      // The host's time_us is microseconds; createdAt on putRecord is ms-ish
      // historically. Keep the host's ordering by passing it through; the
      // host adapter writes time_us = createdAt * 1000 internally so this
      // round-trips. We store the source's time_us directly to preserve
      // ordering across hosts.
      createdAt: p.time_us != null ? Math.floor(p.time_us / 1000) : Date.now(),
    });
  } else if (event.kind === "record.deleted") {
    const p = event.payload;
    await options.recordHost.deleteRecord(p.space, p.collection, p.did, p.rkey);
  }
  // cursor events are handled by the caller for persistence
}

// ---- Schema + cursor persistence ----

const SYNC_SCHEMA_APPLIED = new WeakSet<object>();

/** Idempotent: applies the `record_sync_subscriptions` table on first call
 *  for a given DB. Tracks per-DB (by reference) so repeated calls in tests
 *  don't re-issue DDL each time. */
async function ensureSyncSchema(db: Database): Promise<void> {
  if (SYNC_SCHEMA_APPLIED.has(db as unknown as object)) return;
  const dialect = getDialect(db);
  const stmts = buildRecordSyncSchema(dialect);
  await db.batch(stmts.map((s) => db.prepare(s)));
  SYNC_SCHEMA_APPLIED.add(db as unknown as object);
}

export function buildRecordSyncSchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS record_sync_subscriptions (
      host_url TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      cursor TEXT,
      last_synced_at ${dialect.bigintType},
      PRIMARY KEY (host_url, space_uri)
    )`,
  ];
}

/** SchemaModule-shaped helper for `initSchema({ extraSchemas: [...] })`. */
export async function applyRecordSyncSchema(db: Database): Promise<void> {
  const dialect = getDialect(db);
  const stmts = buildRecordSyncSchema(dialect);
  await db.batch(stmts.map((s) => db.prepare(s)));
}

async function readCursor(
  db: Database,
  hostUrl: string,
  spaceUri: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT cursor FROM record_sync_subscriptions WHERE host_url = ? AND space_uri = ?`
    )
    .bind(hostUrl, spaceUri)
    .first<{ cursor: string | null } | null>();
  return row?.cursor ?? null;
}

async function persistCursor(
  db: Database,
  hostUrl: string,
  spaceUri: string,
  cursor: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO record_sync_subscriptions (host_url, space_uri, cursor, last_synced_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (host_url, space_uri) DO UPDATE SET
         cursor = excluded.cursor,
         last_synced_at = excluded.last_synced_at`
    )
    .bind(hostUrl, spaceUri, cursor, Date.now())
    .run();
}
