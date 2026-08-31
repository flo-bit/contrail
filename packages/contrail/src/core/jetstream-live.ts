import {
  Jetstream,
  websocketTransport,
  type CollectionFilter,
  type LiveOpts,
  type LiveTransport,
  type RawEvent,
  type RawRecordJson,
} from "@bsky/jetstream";

/** Jetstream v2 reserves values at and above this boundary for legacy
 * unix-microsecond timestamp cursors. Real v2 seq cursors stay below it. */
export const JETSTREAM_V2_SEQ_THRESHOLD = 1_000_000_000_000_000;

/** A timestamp bridge intentionally starts slightly before the prior v1
 * position. V1 and v2 are separate instances with separate witness clocks;
 * ordinary source ordering makes the overlap idempotent. */
export const JETSTREAM_V1_BRIDGE_OVERLAP_US = 10_000_000;

export class JetstreamLiveHistoryExpiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JetstreamLiveHistoryExpiredError";
  }
}

export function isJetstreamTimestampCursor(cursor: number): boolean {
  return cursor >= JETSTREAM_V2_SEQ_THRESHOLD;
}

export function advanceJetstreamCursor(
  current: number | null,
  observedSeq: number,
): number {
  if (
    !Number.isSafeInteger(observedSeq) ||
    observedSeq < 0 ||
    observedSeq >= JETSTREAM_V2_SEQ_THRESHOLD
  ) {
    throw new TypeError("Jetstream seq must be in the v2 sequence domain");
  }
  if (current === null || isJetstreamTimestampCursor(current)) {
    return observedSeq;
  }
  return Math.max(current, observedSeq);
}

/** Preserve all six microsecond digits from Jetstream's RFC 3339 display time;
 * Date.parse alone truncates the final three digits. */
export function jetstreamDatetimeToMicroseconds(value: string): number {
  const match = /^(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Invalid Jetstream datetime: ${value}`);
  const wholeMilliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeMilliseconds)) {
    throw new TypeError(`Invalid Jetstream datetime: ${value}`);
  }
  const fractionUs = Number((match[2] ?? "").slice(0, 6).padEnd(6, "0"));
  const result = wholeMilliseconds * 1_000 + fractionUs;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`Jetstream datetime is outside the safe range: ${value}`);
  }
  return result;
}

export type JetstreamLiveEvent =
  | {
      kind: "commit";
      did: string;
      seq: number;
      time_us: number;
      commit:
        | {
            operation: "create" | "update";
            rev: string;
            collection: string;
            rkey: string;
            cid: string;
            record: unknown;
          }
        | {
            operation: "delete";
            rev: string;
            collection: string;
            rkey: string;
          };
    }
  | {
      kind: "identity";
      did: string;
      seq: number;
      time_us: number;
      identity: { did: string; handle?: string; time?: string };
    }
  | {
      kind: "account";
      did: string;
      seq: number;
      time_us: number;
      account: {
        did: string;
        active: boolean;
        status?: string;
        time?: string;
      };
    }
  | {
      kind: "sync";
      did: string;
      seq: number;
      time_us: number;
      sync: { did: string; rev: string; time?: string };
    };

const SUBSCRIBE_EVENTS_NSID = "network.bsky.jetstream.subscribeEvents";

/** A normal HTTP request reaches the same pre-upgrade validation as a
 * WebSocket dial. Hosted v2 services return 426 for an accepted cursor and a
 * structured 400 CursorTooOld before checking Upgrade. Unlike browser
 * WebSockets, fetch exposes that status and body in Workers and browsers. */
async function assertSeqCursorAvailable(options: {
  service: string;
  cursor: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const service = new URL(options.service);
  if (service.protocol === "ws:") service.protocol = "http:";
  if (service.protocol === "wss:") service.protocol = "https:";
  const url = new URL(`/xrpc/${SUBSCRIBE_EVENTS_NSID}`, service.origin);
  url.searchParams.set("cursor", String(options.cursor));
  // Keep this probe independent of a deployment's collection count. Cursor
  // validation is source-global; one valid kind is enough to reach it.
  url.searchParams.set("kinds", "commit");

  const response = await options.fetchImpl.call(globalThis, url, {
    cache: "no-store",
    // Workerd does not implement `redirect: "error"`. Manual redirects remain
    // fail-closed because only the expected 426 response is accepted below.
    redirect: "manual",
    signal: options.signal,
  });
  const body = (await response.text()).slice(0, 2_000);
  let errorName: unknown;
  let message: unknown;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    errorName = parsed.error;
    message = parsed.message;
  } catch {
    // Valid cursors return a plain-text 426 because this probe is deliberately
    // not a WebSocket upgrade.
  }

  if (
    response.status === 400 &&
    (errorName === "CursorTooOld" || /cursor too old/i.test(body))
  ) {
    throw new JetstreamLiveHistoryExpiredError(
      `Jetstream seq cursor is older than the live retention window${typeof message === "string" ? `: ${message}` : ""}`,
    );
  }
  if (response.status !== 426) {
    throw new Error(
      `Jetstream live cursor preflight failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
}

function normalizeLiveEvent(
  event: RawEvent<RawRecordJson>,
): JetstreamLiveEvent {
  const base = {
    did: event.did,
    seq: event.seq,
    time_us: jetstreamDatetimeToMicroseconds(event.time),
  };
  if (event.kind === "commit") {
    const commit = event.commit;
    return commit.operation === "delete"
      ? {
          ...base,
          kind: "commit",
          commit: {
            operation: "delete",
            rev: commit.rev,
            collection: commit.collection,
            rkey: commit.rkey,
          },
        }
      : {
          ...base,
          kind: "commit",
          commit: {
            operation: commit.operation,
            rev: commit.rev,
            collection: commit.collection,
            rkey: commit.rkey,
            cid: commit.cid,
            record: commit.record,
          },
        };
  }
  if (event.kind === "identity") {
    return { ...base, kind: "identity", identity: event.identity };
  }
  if (event.kind === "account") {
    return { ...base, kind: "account", account: event.account };
  }
  return { ...base, kind: "sync", sync: event.sync };
}

export interface JetstreamLiveSubscriptionOptions {
  /** One pinned Jetstream v2 service. Seq cursors are instance-local. */
  url: string;
  cursor?: number;
  wantedCollections?: string[];
  signal?: AbortSignal;
  /** Override fetch or the live transport for tests/custom runtimes. */
  fetchImpl?: typeof fetch;
  liveTransport?: LiveTransport;
  onConnectionOpen?: () => void;
  onConnectionClose?: (event: { code?: number; reason?: string }) => void;
  onConnectionError?: (event: { error: unknown }) => void;
  onInfo?: (info: { name: string; message?: string }) => void;
}

/** Thin live-only adapter over the official v2 client. It deliberately does not
 * use snapshot/replay yet; Contrail's existing PDS/Alluvium paths still own
 * historical acquisition. */
export class JetstreamLiveSubscription
  implements AsyncIterable<JetstreamLiveEvent>
{
  readonly #options: JetstreamLiveSubscriptionOptions;
  readonly #wireCursor: number;
  cursor: number;

  constructor(options: JetstreamLiveSubscriptionOptions) {
    this.#options = options;
    const initial =
      options.cursor ??
      Math.max(0, Date.now() * 1_000 - JETSTREAM_V1_BRIDGE_OVERLAP_US);
    if (!Number.isSafeInteger(initial) || initial < 0) {
      throw new TypeError("Jetstream cursor must be a non-negative safe integer");
    }
    this.cursor = initial;
    this.#wireCursor = isJetstreamTimestampCursor(initial)
      ? Math.max(0, initial - JETSTREAM_V1_BRIDGE_OVERLAP_US)
      : initial;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JetstreamLiveEvent> {
    const options = this.#options;
    const client = new Jetstream(options.url);
    const cursor = { load: async () => this.#wireCursor, async save() {} };
    const transport =
      options.liveTransport ??
      websocketTransport({
        // Browser WebSockets hide HTTP handshake status. Let the enclosing
        // ingestion loop reconnect from its durable cursor instead of allowing
        // ws-client to retry an unclassifiable stale cursor forever.
        shouldReconnect: false,
        onConnect: () => options.onConnectionOpen?.(),
        onClose: (detail) =>
          options.onConnectionClose?.({
            code: detail.code,
            reason: detail.reason,
          }),
        onError: (error) => options.onConnectionError?.({ error }),
      });

    const liveOptions: LiveOpts & { raw: true } = {
      raw: true,
      cursor,
      collections: options.wantedCollections as CollectionFilter[] | undefined,
      // Preserve the legacy live projection surface for now. Account and sync
      // semantics remain a separate Contrail feature rather than being silently
      // claimed by this transport migration.
      kinds: ["commit", "identity"],
      signal: options.signal,
      liveTransport: transport,
      onError: (error) => options.onConnectionError?.({ error }),
      onInfo: (info) => {
        if (info.name === "OutdatedCursor") {
          throw new JetstreamLiveHistoryExpiredError(
            `Jetstream timestamp cursor is older than the live retention window${info.message ? `: ${info.message}` : ""}`,
          );
        }
        options.onInfo?.(info);
      },
    };
    let preflightComplete = false;
    try {
      if (!isJetstreamTimestampCursor(this.#wireCursor)) {
        await assertSeqCursorAvailable({
          service: options.url,
          cursor: this.#wireCursor,
          fetchImpl: options.fetchImpl ?? fetch,
          signal: options.signal,
        });
      }
      preflightComplete = true;
      for await (const event of client.live(liveOptions)) {
        this.cursor = advanceJetstreamCursor(this.cursor, event.seq);
        yield normalizeLiveEvent(event);
      }
    } catch (error) {
      if (error instanceof JetstreamLiveHistoryExpiredError) throw error;
      // Close the race where a cursor crosses the retention floor between the
      // initial HTTP probe and a browser WebSocket handshake. A second probe
      // can promote the otherwise opaque SocketError to the fatal typed error.
      if (
        preflightComplete &&
        !isJetstreamTimestampCursor(this.cursor) &&
        !options.signal?.aborted
      ) {
        try {
          await assertSeqCursorAvailable({
            service: options.url,
            cursor: this.cursor,
            fetchImpl: options.fetchImpl ?? fetch,
            signal: options.signal,
          });
        } catch (probeError) {
          if (probeError instanceof JetstreamLiveHistoryExpiredError) {
            throw probeError;
          }
        }
      }
      throw error;
    }
  }
}
