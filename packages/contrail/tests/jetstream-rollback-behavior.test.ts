import { describe, it, expect } from "vitest";
import { JetstreamSubscription } from "@atcute/jetstream";
import { jetstreamUrlOption } from "../src/core/types";

// This test does NOT mock @atcute. It drives the real JetstreamSubscription and
// captures the actual cursor it would connect with, to PIN the assumption our
// fix relies on: an array url rolls the cursor back 10s on first connect, a
// string url does not. partysocket (the real socket layer @atcute uses) accepts
// an injected `WebSocket` constructor via the `ws` option, so we capture the
// connect URL there without touching @atcute or the network.
const TEN_SECONDS_US = 10_000_000;

/** Construct a real subscription, let it build its connect URL, and return the
 *  `cursor` query param @atcute put on it. */
async function firstConnectCursor(
  url: string | string[],
  cursor: number,
): Promise<number> {
  const connectUrls: string[] = [];

  // Minimal stand-in for a browser WebSocket. partysocket constructs this with
  // the resolved subscribe URL; we record it and otherwise no-op.
  class CapturingSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = CapturingSocket.CONNECTING;
    binaryType = "blob";
    constructor(connectUrl: string | URL) {
      connectUrls.push(String(connectUrl));
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }

  const sub = new JetstreamSubscription({
    url,
    cursor,
    wantedCollections: [],
    ws: { WebSocket: CapturingSocket as unknown as typeof WebSocket },
  });

  // Subscribing triggers the lazy #create() that builds the connect URL.
  const iterator = sub[Symbol.asyncIterator]();
  void iterator.next();

  // partysocket resolves the URL provider and constructs the socket on a later
  // tick; give it a few macrotasks to do so.
  for (let i = 0; i < 10 && connectUrls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await iterator.return?.();

  if (connectUrls.length === 0) {
    throw new Error("subscription never attempted a connection");
  }
  const got = new URL(connectUrls[0]).searchParams.get("cursor");
  return Number(got);
}

describe("@atcute jetstream cursor rollback (behavior our fix depends on)", () => {
  it("rolls the cursor back 10s on first connect for an array url", async () => {
    const cursor = 2_000_000_000;
    const got = await firstConnectCursor(["wss://jetstream.example"], cursor);
    expect(got).toBe(cursor - TEN_SECONDS_US);
  });

  it("does NOT roll the cursor back for a string url", async () => {
    const cursor = 2_000_000_000;
    const got = await firstConnectCursor("wss://jetstream.example", cursor);
    expect(got).toBe(cursor);
  });

  it("jetstreamUrlOption gives a single-instance config the no-rollback (string) shape", async () => {
    const cursor = 2_000_000_000;
    const got = await firstConnectCursor(
      jetstreamUrlOption(["wss://jetstream.example"]),
      cursor,
    );
    expect(got).toBe(cursor);
  });

  it("jetstreamUrlOption keeps a real pool on the rollback (array) shape", async () => {
    const cursor = 2_000_000_000;
    const got = await firstConnectCursor(
      jetstreamUrlOption(["wss://a.example", "wss://b.example"]),
      cursor,
    );
    expect(got).toBe(cursor - TEN_SECONDS_US);
  });
});
