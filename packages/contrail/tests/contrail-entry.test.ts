/** Sanity-checks for the unified Contrail entry point:
 *  - `contrail.app()` returns a Hono instance with routes wired
 *  - `contrail.handler()` is a fetch-compatible function
 *  - the shared pubsub is threaded through so subscribing via the app
 *    receives events published via ingest-path helpers on the same instance. */

import { describe, it, expect } from "vitest";
import { Contrail } from "../src/contrail";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { applyEvents } from "../src/core/db/records";
import type { IngestEvent } from "../src/core/types";

const MSG_NSID = "app.event.message";

describe("Contrail.app() / Contrail.handler()", () => {
  it("handler serves the health endpoint", async () => {
    const db = createSqliteDatabase(":memory:");
    const contrail = new Contrail({
      namespace: "test.entry",
      collections: { message: { collection: MSG_NSID } },
      db,
    });
    await contrail.init();

    const handle = contrail.handler();
    const res = await handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("ok");
  });

  it("shares its pubsub: events from applyEvents reach subscribers of contrail.app()", async () => {
    const db = createSqliteDatabase(":memory:");
    const contrail = new Contrail({
      namespace: "test.entry",
      collections: { message: { collection: MSG_NSID } },
      realtime: { ticketSecret: new Uint8Array(32).fill(1), keepaliveMs: 60_000 },
      db,
    });
    await contrail.init();
    expect(contrail.pubsub).toBeTruthy();

    const app = contrail.app();
    const ac = new AbortController();
    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.entry.realtime.subscribe?topic=${encodeURIComponent("collection:" + MSG_NSID)}`,
        { signal: ac.signal }
      )
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    // Use the same pubsub via the exposed getter — this is the promise
    // of "one Contrail, one pubsub, one app".
    const e: IngestEvent = {
      uri: `at://did:plc:a/${MSG_NSID}/1`,
      did: "did:plc:a",
      time_us: 1,
      collection: MSG_NSID,
      operation: "create",
      rkey: "1",
      cid: "bafy",
      record: JSON.stringify({ text: "shared" }),
      indexed_at: Date.now() * 1000,
    };
    await applyEvents(db, [e], contrail.config, { pubsub: contrail.pubsub ?? undefined });

    // SSE frames separated by "\n\n". Skip any that don't carry a data: line
    // (comments / keepalives).
    const decoder = new TextDecoder();
    let buf = "";
    let payload: any = null;
    while (!payload) {
      const sep = buf.indexOf("\n\n");
      if (sep < 0) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        continue;
      }
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        try { payload = JSON.parse(dataLine.slice(5).trim()); } catch {}
      }
    }
    ac.abort();
    reader.cancel().catch(() => {});

    expect(payload).toBeTruthy();
    expect(payload.kind).toBe("record.created");
    expect(payload.payload.did).toBe("did:plc:a");
  });
});
