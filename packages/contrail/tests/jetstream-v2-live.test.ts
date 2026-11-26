import { describe, expect, it } from "vitest";
import {
  JETSTREAM_V2_SEQ_THRESHOLD,
  JetstreamLiveHistoryExpiredError,
  JetstreamLiveSubscription,
  advanceJetstreamCursor,
  isJetstreamTimestampCursor,
  jetstreamDatetimeToMicroseconds,
} from "../src/core/jetstream-live";
import {
  assertServingSourceCompatibility,
  getLastCursor,
  getServingSourcePosition,
  saveCursor,
} from "../src/index";
import { saveJetstreamCursor } from "../src/core/db/records";
import { createTestDbWithSchema } from "./helpers";

describe("Jetstream v2 live cursor semantics", () => {
  it("rejects a stale seq through HTTP before an opaque browser transport can retry", async () => {
    let transportStarted = false;
    let fetchReceiver: unknown;
    let requestInit: RequestInit | undefined;
    const subscription = new JetstreamLiveSubscription({
      url: "https://jetstream.example",
      cursor: 42,
      fetchImpl: (async function (
        this: unknown,
        input,
        init,
      ) {
        fetchReceiver = this;
        requestInit = init;
        expect(String(input)).toContain(
          "/xrpc/network.bsky.jetstream.subscribeEvents?cursor=42&kinds=commit",
        );
        return new Response(
          JSON.stringify({
            error: "CursorTooOld",
            message: "cursor 42 below lookback floor 100",
          }),
          {
            status: 400,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json",
            },
          },
        );
      }) as typeof fetch,
      liveTransport: {
        stream() {
          transportStarted = true;
          return (async function* () {
            await new Promise(() => {});
          })();
        },
      },
    });

    await expect(
      subscription[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(JetstreamLiveHistoryExpiredError);
    expect(fetchReceiver).toBe(globalThis);
    expect(requestInit).toMatchObject({
      cache: "no-store",
      redirect: "manual",
    });
    expect(transportStarted).toBe(false);
  });

  it("rejects a manual redirect instead of following or accepting it", async () => {
    let transportStarted = false;
    const subscription = new JetstreamLiveSubscription({
      url: "https://jetstream.example",
      cursor: 42,
      fetchImpl: (async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response("redirected", {
          status: 302,
          headers: { location: "https://elsewhere.example" },
        });
      }) as typeof fetch,
      liveTransport: {
        stream() {
          transportStarted = true;
          return (async function* () {
            await new Promise(() => {});
          })();
        },
      },
    });

    await expect(
      subscription[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("Jetstream live cursor preflight failed (302)");
    expect(transportStarted).toBe(false);
  });

  it("does not misclassify an unverified WebSocket 400 as expired history", async () => {
    const handshakeError = new Error("Unexpected server response: 400");
    const fetchReceivers: unknown[] = [];
    let preflightCalls = 0;
    const subscription = new JetstreamLiveSubscription({
      url: "https://jetstream.example",
      cursor: 42,
      // Both the initial probe and the post-failure probe prove only that the
      // cursor is accepted. The actual filtered WebSocket request may still be
      // rejected for an unrelated InvalidRequest.
      fetchImpl: (async function (this: unknown, _input, init) {
        preflightCalls++;
        fetchReceivers.push(this);
        expect(init?.redirect).toBe("manual");
        return new Response("WebSocket upgrade required", { status: 426 });
      }) as typeof fetch,
      liveTransport: {
        stream() {
          return (async function* () {
            throw handshakeError;
          })();
        },
      },
    });

    const error = await subscription[Symbol.asyncIterator]().next().catch(
      (value: unknown) => value,
    );
    expect(error).toBe(handshakeError);
    expect(error).not.toBeInstanceOf(JetstreamLiveHistoryExpiredError);
    expect(preflightCalls).toBe(2);
    expect(fetchReceivers).toEqual([globalThis, globalThis]);
  });

  it("subscribes to and normalizes account lifecycle events on the real transport", async () => {
    const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    const time = "2026-08-29T13:08:26.865272Z";
    const subscription = new JetstreamLiveSubscription({
      url: "https://jetstream.example",
      cursor: 42,
      wantedCollections: ["com.example.post"],
      fetchImpl: (async () => new Response("Upgrade required", { status: 426 })) as typeof fetch,
      liveTransport: {
        async *stream(getUrl) {
          const url = new URL(getUrl());
          expect(url.searchParams.getAll("kinds")).toEqual([
            "commit", "identity", "account",
          ]);
          expect(url.searchParams.getAll("collections")).toEqual(["com.example.post"]);
          yield JSON.stringify({
            $type: "message",
            payload: {
              $type: "network.bsky.jetstream.subscribeEvents#account",
              did, seq: 43, time,
              account: { did, active: false, status: "deactivated" },
            },
          });
          yield JSON.stringify({
            $type: "message",
            payload: {
              $type: "network.bsky.jetstream.subscribeEvents#account",
              did, seq: 44, time,
              account: { did, active: true },
            },
          });
        },
      },
    });
    const events = [];
    for await (const event of subscription) events.push(event);
    expect(events).toEqual([
      {
        kind: "account", did, seq: 43, time_us: 1_788_008_906_865_272,
        account: { did, active: false, status: "deactivated" },
      },
      {
        kind: "account", did, seq: 44, time_us: 1_788_008_906_865_272,
        account: { did, active: true },
      },
    ]);
    expect(subscription.cursor).toBe(44);
  });

  it("preserves microsecond precision from the v2 datetime", () => {
    expect(
      jetstreamDatetimeToMicroseconds("2026-08-29T13:08:26.865272Z"),
    ).toBe(1_788_008_906_865_272);
    expect(
      jetstreamDatetimeToMicroseconds("2026-08-29T15:08:26.865272+02:00"),
    ).toBe(1_788_008_906_865_272);
  });

  it("moves one way from a timestamp bridge to monotonic seqs", () => {
    const timestamp = 1_788_008_906_865_272;
    expect(isJetstreamTimestampCursor(timestamp)).toBe(true);
    expect(isJetstreamTimestampCursor(25_304_406_049)).toBe(false);
    expect(advanceJetstreamCursor(timestamp, 25_304_406_049)).toBe(
      25_304_406_049,
    );
    expect(advanceJetstreamCursor(25_304_406_049, 25_304_406_048)).toBe(
      25_304_406_049,
    );
    expect(JETSTREAM_V2_SEQ_THRESHOLD).toBe(1_000_000_000_000_000);
  });

  it("atomically replaces a legacy timestamp and rejects stale domain rollback", async () => {
    const db = await createTestDbWithSchema();
    const timestamp = 1_788_008_906_865_272;
    const source = { source: "jetstream", epoch: "v2" };

    await saveCursor(db, timestamp, { source: "jetstream", epoch: "v1" });
    await assertServingSourceCompatibility(db, source);

    await saveJetstreamCursor(db, 25_304_406_049, source);
    expect(await getLastCursor(db)).toBe(25_304_406_049);
    expect(await getServingSourcePosition(db)).toMatchObject({
      position: {
        source: "jetstream",
        epoch: "v2",
        cursor: "25304406049",
      },
    });

    await saveJetstreamCursor(db, timestamp + 1, source);
    expect(await getLastCursor(db)).toBe(25_304_406_049);
  });

  it("prevents a legacy writer from rolling a v2 cursor and epoch back", async () => {
    const db = await createTestDbWithSchema();
    const timestamp = 1_788_008_906_865_272;
    await saveJetstreamCursor(db, 42, {
      source: "jetstream",
      epoch: "v2-epoch",
    });

    await saveCursor(
      db,
      timestamp,
      { source: "jetstream", epoch: "stale-v1-epoch" },
    );

    expect(await getLastCursor(db)).toBe(42);
    expect(await getServingSourcePosition(db)).toMatchObject({
      position: {
        source: "jetstream",
        epoch: "v2-epoch",
        cursor: "42",
      },
    });
  });

  it("still rejects an epoch mismatch after the cursor is in the seq domain", async () => {
    const db = await createTestDbWithSchema();
    await saveJetstreamCursor(db, 42, {
      source: "jetstream",
      epoch: "first-v2-epoch",
    });
    await expect(
      assertServingSourceCompatibility(db, {
        source: "jetstream",
        epoch: "different-v2-epoch",
      }),
    ).rejects.toThrow("does not match durable source position");
  });

  it("rejects an epoch change when an unscoped writer already moved the live cursor to v2", async () => {
    const db = await createTestDbWithSchema();
    const timestamp = 1_788_008_906_865_272;
    await saveCursor(db, timestamp, {
      source: "jetstream",
      epoch: "legacy-epoch",
    });

    // Ingestion can temporarily run without orderedSource. That advances the
    // authoritative live cursor while leaving source_position untouched.
    await saveJetstreamCursor(db, 42);
    expect(await getServingSourcePosition(db)).toMatchObject({
      position: {
        source: "jetstream",
        epoch: "legacy-epoch",
        cursor: String(timestamp),
      },
    });

    await expect(
      assertServingSourceCompatibility(db, {
        source: "jetstream",
        epoch: "new-epoch",
      }),
    ).rejects.toThrow("does not match durable source position");
  });
});
