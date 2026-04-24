/** Durable Object backend for realtime PubSub.
 *
 *  Two pieces live here:
 *   1. `RealtimePubSubDO` — the DO class. Ship it from your Worker via
 *      `export { RealtimePubSubDO } from "@atmo-dev/contrail";` and bind it in
 *      your `wrangler.toml`. One DO = one topic; addressed by name.
 *   2. `DurableObjectPubSub` — client-side adapter implementing the PubSub
 *      interface against a DO namespace binding.
 *
 *  Wire format between Worker and DO (internal, not a stable public contract):
 *    POST  /publish    — body = RealtimeEvent JSON
 *    GET   /subscribe  — server-sent events stream, optionally with
 *                         `Upgrade: websocket` for WS connections.
 *                         Auth/ACL is already checked at the Worker edge;
 *                         the DO trusts anything that reaches it. */

import type { PubSub, RealtimeEvent } from "./types";
import { translateForQuery, type TranslatedEnvelope } from "./query-filter";
type TranslatedEvent = TranslatedEnvelope;

/** Query spec attached to a WS subscriber, used to filter events before
 *  delivery. Shape matches what the Worker's `watchRecords` handler builds;
 *  forwarded to the DO via trusted internal headers on the WS upgrade. */
export interface SubscriberQuerySpec {
  /** NSID of the primary collection the client is watching. */
  collection: string;
  /** Space URI this subscription is scoped to. Events outside are dropped. */
  spaceUri: string;
  /** Hydrated relations. Keyed by relName — value is the child collection
   *  NSID and the field on the child record that references the parent. */
  hydrate?: Record<string, { childCollection: string; matchField: string }>;
}

// ---- Minimal structural typings so we don't depend on @cloudflare/workers-types
// at the library level. Callers on Workers will have proper types.
// ----------------------------------------------------------------------------

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectState {
  acceptWebSocket(ws: any, tags?: string[]): void;
  getWebSockets(tag?: string): any[];
}

// ----------------------------------------------------------------------------
// Client adapter
// ----------------------------------------------------------------------------

export class DurableObjectPubSub implements PubSub {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(topic: string): DurableObjectStub {
    return this.namespace.get(this.namespace.idFromName(topic));
  }

  async publish(event: RealtimeEvent): Promise<void> {
    const res = await this.stub(event.topic).fetch("https://do/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      // Consume the body so the edge doesn't hold a dangling response.
      await res.text().catch(() => "");
      throw new Error(`DO publish failed (${res.status})`);
    }
  }

  /** In-Worker server-side subscribe. Browsers should hit the SSE endpoint
   *  directly; this is the path for an in-process consumer that wants an
   *  AsyncIterable (tests, bots embedded in the Worker). */
  subscribe(topic: string, signal?: AbortSignal): AsyncIterable<RealtimeEvent> {
    const stub = this.stub(topic);
    return {
      [Symbol.asyncIterator]() {
        return pullIterator(stub, signal);
      },
    };
  }

  /** Forward an incoming browser WS upgrade (or SSE GET) through to the DO
   *  that owns this topic, attaching a query-filter spec that the DO will use
   *  to decide what to deliver. The Worker must verify auth + spec validity
   *  before calling this — the DO trusts the headers. */
  async forwardSubscribe(
    topic: string,
    request: Request,
    opts: {
      did?: string;
      querySpec?: SubscriberQuerySpec;
      /** Unix ms. DO replays any buffered event with ts > sinceTs before
       *  going live — closes the snapshot→WS race window on the client. */
      sinceTs?: number;
    } = {}
  ): Promise<Response> {
    const headers = new Headers(request.headers);
    if (opts.querySpec) {
      headers.set("X-Contrail-Query-Spec", JSON.stringify(opts.querySpec));
    }
    const url = new URL("https://do/subscribe");
    if (opts.did) url.searchParams.set("did", opts.did);
    if (opts.sinceTs && opts.sinceTs > 0) {
      url.searchParams.set("sinceTs", String(opts.sinceTs));
    }
    return this.stub(topic).fetch(url.toString(), {
      method: "GET",
      headers
    });
  }
}

function pullIterator(
  stub: DurableObjectStub,
  signal?: AbortSignal
): AsyncIterator<RealtimeEvent> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let buf = "";
  const decoder = new TextDecoder();
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const open = async () => {
    const res = await stub.fetch("https://do/subscribe", {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`DO subscribe failed (${res.status})`);
    reader = res.body.getReader();
  };

  return {
    async next(): Promise<IteratorResult<RealtimeEvent>> {
      if (!reader) await open();
      while (true) {
        // Drain buffered frames.
        while (true) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let data: string | null = null;
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data) {
            try {
              return { value: JSON.parse(data) as RealtimeEvent, done: false };
            } catch {
              /* skip malformed */
            }
          }
        }
        if (ac.signal.aborted) return { value: undefined, done: true };
        const r = await reader!.read();
        if (r.done) return { value: undefined, done: true };
        buf += decoder.decode(r.value, { stream: true });
      }
    },
    async return(): Promise<IteratorResult<RealtimeEvent>> {
      ac.abort();
      try {
        await reader?.cancel();
      } catch {
        /* ignore */
      }
      return { value: undefined, done: true };
    },
  };
}

// ----------------------------------------------------------------------------
// Durable Object class
// ----------------------------------------------------------------------------

/** The Durable Object implementation. Each DO instance owns the fan-out for
 *  exactly one topic. WebSocket connections are stored via the Hibernation
 *  API (`state.acceptWebSocket`) so idle rooms cost near-zero.
 *
 *  This class intentionally avoids the `DurableObject` base class so we don't
 *  have to depend on @cloudflare/workers-types at the library level — users
 *  wire it up directly in their Worker entry. */
/** Rolling buffer of recent events, used to close the snapshot→WS race:
 *  when a new subscriber connects with `?sinceTs=X`, replay any buffered
 *  event with `event.ts > X` before going live. Bounded by count + age so
 *  memory stays small. */
const RECENT_BUFFER_MS = 15_000;
const RECENT_BUFFER_MAX = 500;

export class RealtimePubSubDO {
  private readonly recentEvents: RealtimeEvent[] = [];

  constructor(
    protected readonly state: DurableObjectState,
    _env?: unknown
  ) {}

  private pushRecent(event: RealtimeEvent): void {
    this.recentEvents.push(event);
    const cutoff = Date.now() - RECENT_BUFFER_MS;
    while (
      this.recentEvents.length > RECENT_BUFFER_MAX ||
      (this.recentEvents.length > 0 && this.recentEvents[0]!.ts < cutoff)
    ) {
      this.recentEvents.shift();
    }
  }

  /** Worker entry delegates `fetch` to this method. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      let event: RealtimeEvent;
      try {
        event = (await request.json()) as RealtimeEvent;
      } catch {
        return new Response(JSON.stringify({ error: "InvalidRequest" }), { status: 400 });
      }
      this.publishEvent(event);
      return new Response("{}", { status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/subscribe") {
      const did = url.searchParams.get("did") ?? undefined;
      const sinceTsRaw = url.searchParams.get("sinceTs");
      const sinceTs = sinceTsRaw ? Number(sinceTsRaw) : 0;
      // Optional query-filter spec, forwarded by the Worker after it has
      // verified the caller's auth + access. Parsed once here; the parsed
      // object is serialized into the WS attachment so the DO can filter
      // events on publish without re-parsing.
      let querySpec: SubscriberQuerySpec | undefined;
      const rawSpec = request.headers.get("X-Contrail-Query-Spec");
      if (rawSpec) {
        try {
          querySpec = JSON.parse(rawSpec) as SubscriberQuerySpec;
        } catch {
          return new Response(
            JSON.stringify({ error: "InvalidRequest", message: "bad X-Contrail-Query-Spec" }),
            { status: 400 }
          );
        }
      }

      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const Pair = (globalThis as unknown as { WebSocketPair?: any }).WebSocketPair;
        if (!Pair) return new Response("websockets require Workers", { status: 426 });
        const pair = new Pair();
        this.acceptWebSocketSubscriber(pair[1], did, querySpec);
        if (sinceTs > 0) this.replayRecentTo(pair[1], sinceTs);
        return new Response(null, {
          status: 101,
          // Workers-specific init field
          webSocket: pair[0],
        } as ResponseInit & { webSocket: unknown });
      }
      return this.openSseResponse(did, querySpec, sinceTs);
    }
    return new Response("not found", { status: 404 });
  }

  /** Fan-out an event to every connected subscriber (WS + SSE).
   *  Public so tests + advanced callers can skip the HTTP layer.
   *
   *  If a subscriber has attached a `querySpec`, we translate the raw event
   *  into 0–1 watchRecords-shaped events (record.created, record.deleted,
   *  hydration.added, hydration.removed) and deliver only those. Otherwise
   *  the raw event is delivered as-is (topic-firehose behaviour for the
   *  `realtime.subscribe` endpoint). */
  publishEvent(event: RealtimeEvent): void {
    // Buffer first so a subscriber connecting mid-publish (race-window
    // replay) can pick up this event too once they provide their sinceTs.
    this.pushRecent(event);

    const rawPayload = JSON.stringify(event);
    const rawFrame = `event: ${event.kind}\ndata: ${rawPayload}\n\n`;

    for (const ws of this.state.getWebSockets()) {
      const attachment = getAttachment(ws);

      if (attachment?.querySpec) {
        const translated = translateForQuery(event, attachment);
        if (translated) this.writeSubscriberState(ws, attachment, translated);
        for (const msg of translated ?? []) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          ws.send(rawPayload);
        } catch {
          /* ignore */
        }
      }

      if (
        event.kind === "member.removed" &&
        attachment?.did &&
        event.payload.did === attachment.did
      ) {
        try {
          ws.close(4003, "membership-revoked");
        } catch {
          /* ignore */
        }
      }
    }

    for (const entry of this.sseControllers) {
      if (entry.querySpec) {
        const translated = translateForQuery(event, entry);
        if (translated) this.writeSubscriberStateForSse(entry, translated);
        for (const msg of translated ?? []) {
          try {
            entry.controller.enqueue(
              this.encoder.encode(`event: ${msg.kind}\ndata: ${JSON.stringify(msg.data)}\n\n`)
            );
          } catch {
            /* drop */
          }
        }
      } else {
        try {
          entry.controller.enqueue(this.encoder.encode(rawFrame));
        } catch {
          /* drop; cleanup happens on the subscribe-side */
        }
      }

      if (
        event.kind === "member.removed" &&
        entry.did &&
        event.payload.did === entry.did
      ) {
        try {
          entry.controller.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Register a server-side WebSocket as a subscriber. Wires the DID +
   *  optional query spec into the hibernation attachment so this DO can
   *  filter and route events after going to sleep. */
  acceptWebSocketSubscriber(
    serverWs: any,
    did?: string,
    querySpec?: SubscriberQuerySpec
  ): void {
    this.state.acceptWebSocket(serverWs, did ? [did] : undefined);
    if (did || querySpec) {
      setAttachment(serverWs, {
        did,
        querySpec,
        parentUris: [],
        childToParent: {}
      });
    }
  }

  /** Open an SSE subscriber; returns the streaming Response. */
  openSseResponse(
    did?: string,
    querySpec?: SubscriberQuerySpec,
    sinceTs = 0
  ): Response {
    let entry: SseEntry;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry = {
          controller,
          did,
          querySpec,
          parentUris: new Set(),
          childToParent: new Map()
        };
        this.sseControllers.add(entry);
        controller.enqueue(this.encoder.encode(`: open\n\n`));
        if (sinceTs > 0) this.replayRecentToSse(entry, sinceTs);
      },
      cancel: () => {
        this.sseControllers.delete(entry);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  /** Replay buffered events with ts > sinceTs through this subscriber's
   *  query-spec filter. Called once, synchronously, on WS connect. */
  private replayRecentTo(ws: any, sinceTs: number): void {
    const attachment = getAttachment(ws);
    for (const event of this.recentEvents) {
      if (event.ts <= sinceTs) continue;
      if (attachment?.querySpec) {
        const translated = translateForQuery(event, attachment);
        if (translated) this.writeSubscriberState(ws, attachment, translated);
        for (const msg of translated ?? []) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          /* ignore */
        }
      }
    }
  }

  private replayRecentToSse(entry: SseEntry, sinceTs: number): void {
    for (const event of this.recentEvents) {
      if (event.ts <= sinceTs) continue;
      if (entry.querySpec) {
        const translated = translateForQuery(event, entry);
        if (translated) this.writeSubscriberStateForSse(entry, translated);
        for (const msg of translated ?? []) {
          try {
            entry.controller.enqueue(
              this.encoder.encode(`event: ${msg.kind}\ndata: ${JSON.stringify(msg.data)}\n\n`)
            );
          } catch {
            /* drop */
          }
        }
      } else {
        try {
          entry.controller.enqueue(
            this.encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          /* drop */
        }
      }
    }
  }

  /** Update the persisted WS attachment state after we've decided which
   *  events to forward. Keeps the parent/child tracking tables warm across
   *  hibernation. */
  private writeSubscriberState(
    ws: any,
    attachment: WsAttachment,
    translated: TranslatedEvent[]
  ): void {
    let dirty = false;
    for (const msg of translated) {
      if (msg.kind === "record.created" && msg.data.record?.uri) {
        attachment.parentUris = Array.from(
          new Set([...(attachment.parentUris ?? []), msg.data.record.uri])
        );
        dirty = true;
      } else if (msg.kind === "record.deleted" && msg.data.uri) {
        const before = attachment.parentUris ?? [];
        attachment.parentUris = before.filter((u) => u !== msg.data.uri);
        if (attachment.parentUris.length !== before.length) dirty = true;
      } else if (msg.kind === "hydration.added" && msg.data.child?.rkey) {
        attachment.childToParent = {
          ...(attachment.childToParent ?? {}),
          [msg.data.child.rkey]: {
            parentUri: msg.data.parentUri,
            relName: msg.data.relation
          }
        };
        dirty = true;
      } else if (msg.kind === "hydration.removed" && msg.data.childRkey) {
        const next = { ...(attachment.childToParent ?? {}) };
        if (next[msg.data.childRkey]) {
          delete next[msg.data.childRkey];
          attachment.childToParent = next;
          dirty = true;
        }
      }
    }
    if (dirty) setAttachment(ws, attachment);
  }

  private writeSubscriberStateForSse(
    entry: SseEntry,
    translated: TranslatedEvent[]
  ): void {
    for (const msg of translated) {
      if (msg.kind === "record.created" && msg.data.record?.uri) {
        entry.parentUris?.add(msg.data.record.uri);
      } else if (msg.kind === "record.deleted" && msg.data.uri) {
        entry.parentUris?.delete(msg.data.uri);
      } else if (msg.kind === "hydration.added" && msg.data.child?.rkey) {
        entry.childToParent?.set(msg.data.child.rkey, {
          parentUri: msg.data.parentUri,
          relName: msg.data.relation
        });
      } else if (msg.kind === "hydration.removed" && msg.data.childRkey) {
        entry.childToParent?.delete(msg.data.childRkey);
      }
    }
  }

  private readonly sseControllers = new Set<SseEntry>();
  private readonly encoder = new TextEncoder();
}

interface SseEntry {
  controller: ReadableStreamDefaultController<Uint8Array>;
  did: string | undefined;
  querySpec?: SubscriberQuerySpec;
  parentUris?: Set<string>;
  childToParent?: Map<string, { parentUri: string; relName: string }>;
}

interface WsAttachment {
  did?: string;
  querySpec?: SubscriberQuerySpec;
  /** URIs of primary records currently in this subscriber's result set. */
  parentUris?: string[];
  /** childRkey → parent info, for routing child delete events. */
  childToParent?: Record<string, { parentUri: string; relName: string }>;
}

function setAttachment(ws: any, attachment: WsAttachment): void {
  try {
    ws.serializeAttachment?.(attachment);
  } catch {
    /* non-hibernating socket — fall back to a direct property */
    ws.__attachment = attachment;
  }
}

function getAttachment(ws: any): WsAttachment | null {
  try {
    const a = ws.deserializeAttachment?.();
    if (a) return a as WsAttachment;
  } catch {
    /* ignore */
  }
  return (ws.__attachment as WsAttachment | undefined) ?? null;
}

// Query-spec filtering lives in ./query-filter so the Worker can reuse it for
// non-DO (InMemoryPubSub) watchRecords paths without bundling the whole DO.
