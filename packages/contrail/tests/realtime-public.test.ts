/** Realtime — public topics (`collection:<nsid>`, `actor:<did>`):
 *   - Subscribe requires no auth.
 *   - Events are published by `applyEvents` (the jetstream/public-record path),
 *     not by the spaces adapter. Spaces can be entirely absent from config. */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { applyEvents } from "../src/core/db/records";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig, IngestEvent } from "../src/core/types";
import { InMemoryPubSub } from "../src/core/realtime/in-memory";
import type { RealtimeEvent } from "../src/core/realtime/types";

const REALTIME_SECRET = new Uint8Array(32).fill(9);

const ALICE = "did:plc:alice";
const MSG_NSID = "app.event.message";

function baseConfig(pubsub: InMemoryPubSub): ContrailConfig {
  return {
    namespace: "test.pub",
    collections: { message: { collection: MSG_NSID } },
    realtime: {
      ticketSecret: REALTIME_SECRET,
      pubsub,
      keepaliveMs: 60_000,
    },
  };
}

/** Open SSE and return an async iterator over decoded events. */
async function openSse(app: Hono, path: string): Promise<{
  events: AsyncIterator<RealtimeEvent>;
  close: () => void;
}> {
  const ac = new AbortController();
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { method: "GET", signal: ac.signal })
  );
  if (!res.ok) throw new Error(`SSE open failed: ${res.status} ${await res.text()}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const iter: AsyncIterator<RealtimeEvent> = {
    async next() {
      while (true) {
        const sep = buf.indexOf("\n\n");
        if (sep >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              try { return { done: false, value: JSON.parse(line.slice(5).trim()) }; } catch {}
            }
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return { done: true, value: undefined as any };
        buf += decoder.decode(value, { stream: true });
      }
    },
  };
  return {
    events: iter,
    close: () => { ac.abort(); reader.cancel().catch(() => {}); },
  };
}

describe("realtime — public topics work without spaces and without auth", () => {
  it("subscribes to collection:<nsid> without auth and receives jetstream events", async () => {
    const db = createSqliteDatabase(":memory:");
    const pubsub = new InMemoryPubSub();
    const config = resolveConfig(baseConfig(pubsub));
    await initSchema(db, config);
    const app = createApp(db, config);

    const { events, close } = await openSse(
      app,
      `/xrpc/test.pub.realtime.subscribe?topic=${encodeURIComponent("collection:" + MSG_NSID)}`
    );

    // Simulate a public record landing via jetstream.
    const e: IngestEvent = {
      uri: `at://${ALICE}/${MSG_NSID}/abc`,
      did: ALICE,
      time_us: 1_700_000_000_000_000,
      collection: MSG_NSID,
      operation: "create",
      rkey: "abc",
      cid: "bafytest",
      record: JSON.stringify({ text: "hi" }),
      indexed_at: Date.now() * 1000,
    };
    await applyEvents(db, [e], config, { pubsub });

    const next = await events.next();
    expect(next.done).toBe(false);
    const event = next.value as RealtimeEvent & { kind: "record.created" };
    expect(event.kind).toBe("record.created");
    expect(event.payload.uri).toBe(e.uri);
    expect(event.payload.did).toBe(ALICE);
    expect(event.payload.collection).toBe(MSG_NSID);
    expect(event.payload.record).toEqual({ text: "hi" });
    expect((event.payload as any).space).toBeUndefined();
    close();
  });

  it("actor:<did> is subscribable without auth and receives events for that DID", async () => {
    const db = createSqliteDatabase(":memory:");
    const pubsub = new InMemoryPubSub();
    const config = resolveConfig(baseConfig(pubsub));
    await initSchema(db, config);
    const app = createApp(db, config);

    const { events, close } = await openSse(
      app,
      `/xrpc/test.pub.realtime.subscribe?topic=${encodeURIComponent("actor:" + ALICE)}`
    );

    const e: IngestEvent = {
      uri: `at://${ALICE}/${MSG_NSID}/xyz`,
      did: ALICE,
      time_us: 1_700_000_000_000_000,
      collection: MSG_NSID,
      operation: "create",
      rkey: "xyz",
      cid: "bafy",
      record: JSON.stringify({ text: "from actor feed" }),
      indexed_at: Date.now() * 1000,
    };
    await applyEvents(db, [e], config, { pubsub });

    const next = await events.next();
    expect(next.done).toBe(false);
    const event = next.value as RealtimeEvent & { kind: "record.created" };
    expect(event.topic).toBe(`actor:${ALICE}`);
    expect(event.payload.did).toBe(ALICE);
    close();
  });

  it("private topic without auth middleware returns 400 with a helpful error", async () => {
    const db = createSqliteDatabase(":memory:");
    const pubsub = new InMemoryPubSub();
    const config = resolveConfig(baseConfig(pubsub));
    await initSchema(db, config);
    const app = createApp(db, config);

    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.pub.realtime.subscribe?topic=${encodeURIComponent("space:at://x/y/z")}`
      )
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.reason).toBe("private-topic-without-auth");
  });
});
