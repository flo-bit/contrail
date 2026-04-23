/** Unit tests for the DO class and the DO client adapter.
 *
 *  We don't run wrangler here — instead we hand-roll a tiny fake `DurableObjectState`
 *  and fake WebSocket pair so we can drive the class's public `fetch` method
 *  directly. That's enough to verify routing, fan-out, kick-on-remove, and the
 *  client-side SSE pull iterator. */

import { describe, it, expect } from "vitest";
import {
  DurableObjectPubSub,
  RealtimePubSubDO,
  type DurableObjectState,
  type DurableObjectNamespace,
  type DurableObjectStub,
} from "../src/core/realtime/durable-object";
import type { RealtimeEvent } from "../src/core/realtime/types";

// ---- Fakes -----------------------------------------------------------------

class FakeWebSocket {
  public readonly sent: string[] = [];
  public closedCode: number | undefined;
  private attachment: unknown = null;
  serializeAttachment(a: unknown): void {
    this.attachment = a;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(code?: number): void {
    this.closedCode = code;
  }
  // For the test harness — required so the class can upgrade an incoming request.
  accept(): void {}
}

class FakeState implements DurableObjectState {
  private readonly sockets: FakeWebSocket[] = [];
  acceptWebSocket(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }
  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }
}

function mkEvent(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    topic: "space:at://x/y/z",
    kind: "record.created",
    payload: {
      uri: "at://did:plc:x/c/r",
      did: "did:plc:x",
      collection: "c",
      rkey: "r",
      cid: null,
      record: {},
      time_us: 1,
      space: "at://x/y/z",
    },
    ts: 1,
    ...(overrides as any),
  };
}

// ---- DO class tests --------------------------------------------------------

describe("RealtimePubSubDO — publish/fanout", () => {
  it("fans out publishEvent to all accepted websockets", async () => {
    const state = new FakeState();
    const doInstance = new RealtimePubSubDO(state);

    for (const did of ["did:plc:a", "did:plc:b"]) {
      doInstance.acceptWebSocketSubscriber(new FakeWebSocket(), did);
    }

    doInstance.publishEvent(mkEvent({ ts: 42 }));

    const sockets = state.getWebSockets();
    expect(sockets).toHaveLength(2);
    for (const ws of sockets) {
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]!).ts).toBe(42);
    }
  });

  it("kicks WS whose attachment.did matches a member.removed event", async () => {
    const state = new FakeState();
    const doInstance = new RealtimePubSubDO(state);

    doInstance.acceptWebSocketSubscriber(new FakeWebSocket(), "did:plc:kickme");
    doInstance.acceptWebSocketSubscriber(new FakeWebSocket(), "did:plc:stay");

    doInstance.publishEvent({
      topic: "space:x",
      kind: "member.removed",
      payload: { space: "at://x/y/z", did: "did:plc:kickme" },
      ts: 1,
    });

    const [kicked, staying] = state.getWebSockets();
    expect(kicked!.closedCode).toBe(4003);
    expect(staying!.closedCode).toBeUndefined();
  });

  it("delivers SSE to pull-style subscribers and closes the stream on self-kick", async () => {
    const state = new FakeState();
    const doInstance = new RealtimePubSubDO(state);

    const subRes = doInstance.openSseResponse("did:plc:self");
    expect(subRes.status).toBe(200);
    const reader = subRes.body!.getReader();

    const collect = async (target: number) => {
      const decoder = new TextDecoder();
      const events: RealtimeEvent[] = [];
      let buf = "";
      while (events.length < target) {
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        if (done) break;
        while (true) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
            }
          }
        }
      }
      return events;
    };

    // Publish a regular event, then a self-targeting member.removed.
    doInstance.publishEvent(mkEvent({ ts: 7 }));
    doInstance.publishEvent({
      topic: "space:x",
      kind: "member.removed",
      payload: { space: "at://x/y/z", did: "did:plc:self" },
      ts: 8,
    });

    const events = await collect(2);
    expect(events.map((e) => e.kind)).toEqual(["record.created", "member.removed"]);

    // Stream should be closed after the self-kick.
    const tail = await reader.read();
    expect(tail.done).toBe(true);
  });
});

// ---- Client adapter tests --------------------------------------------------

describe("DurableObjectPubSub — client adapter", () => {
  it("routes publish to the correct DO by topic name", async () => {
    const calls: Array<{ name: string; url: string; init?: RequestInit }> = [];
    const stubFor = (name: string): DurableObjectStub => ({
      async fetch(input, init) {
        const url = typeof input === "string" ? input : (input as URL | Request).toString();
        calls.push({ name, url, init });
        return new Response("{}", { status: 200 });
      },
    });
    const ns: DurableObjectNamespace = {
      idFromName: (n: string) => ({ toString: () => n }),
      get: (id) => stubFor(id.toString()),
    };
    const ps = new DurableObjectPubSub(ns);

    await ps.publish(mkEvent({ topic: "space:a" }));
    await ps.publish(mkEvent({ topic: "community:c1" }));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe("space:a");
    expect(calls[0]!.url).toContain("/publish");
    expect(calls[1]!.name).toBe("community:c1");
  });

  it("subscribes via SSE and pulls parsed events", async () => {
    // Simulate a DO that streams two SSE events, then ends.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(": open\n\n"));
        controller.enqueue(
          enc.encode(`event: record.created\ndata: ${JSON.stringify(mkEvent({ ts: 1 }))}\n\n`)
        );
        controller.enqueue(
          enc.encode(`event: record.created\ndata: ${JSON.stringify(mkEvent({ ts: 2 }))}\n\n`)
        );
        controller.close();
      },
    });
    const stubFor = (): DurableObjectStub => ({
      async fetch() {
        return new Response(stream, { status: 200 });
      },
    });
    const ns: DurableObjectNamespace = {
      idFromName: (n) => ({ toString: () => n }),
      get: () => stubFor(),
    };
    const ps = new DurableObjectPubSub(ns);

    const received: RealtimeEvent[] = [];
    for await (const e of ps.subscribe("space:a")) {
      received.push(e);
    }
    expect(received.map((e) => e.ts)).toEqual([1, 2]);
  });

  it("ends the pull iterator when return() is called", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* never emits */
      },
      cancel() {
        canceled = true;
      },
    });
    const ns: DurableObjectNamespace = {
      idFromName: (n) => ({ toString: () => n }),
      get: () => ({
        async fetch() {
          return new Response(stream, { status: 200 });
        },
      }),
    };
    const ps = new DurableObjectPubSub(ns);
    const iter = ps.subscribe("space:a")[Symbol.asyncIterator]();
    // Kick off open() so reader exists, then explicitly return.
    const next = iter.next();
    // Let the iterator attach its reader before returning.
    await new Promise((r) => setTimeout(r, 0));
    await iter.return!();
    const r = await next;
    expect(r.done).toBe(true);
    expect(canceled).toBe(true);
  });
});
