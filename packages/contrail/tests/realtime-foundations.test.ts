import { describe, it, expect } from "vitest";
import { InMemoryPubSub } from "../src/core/realtime/in-memory";
import { TicketSigner } from "../src/core/realtime/ticket";
import type { RealtimeEvent } from "../src/core/realtime/types";
import { spaceTopic } from "../src/core/realtime/types";

const SECRET = new Uint8Array(32).fill(3);

function mk(topic: string, n: number): RealtimeEvent {
  return {
    topic,
    kind: "record.created",
    payload: {
      uri: `at://did:plc:x/c/${n}`,
      did: "did:plc:x",
      collection: "c",
      rkey: String(n),
      cid: null,
      record: {},
      time_us: n,
      space: "at://x/y/z",
    },
    ts: n,
  };
}

describe("InMemoryPubSub", () => {
  it("delivers events to a subscriber on the same topic", async () => {
    const ps = new InMemoryPubSub();
    const topic = spaceTopic("at://x/y/z");
    const it = ps.subscribe(topic)[Symbol.asyncIterator]();
    await ps.publish(mk(topic, 1));
    const r = await it.next();
    expect(r.done).toBe(false);
    expect((r.value as RealtimeEvent).ts).toBe(1);
    await it.return?.();
  });

  it("fans out to multiple subscribers on the same topic", async () => {
    const ps = new InMemoryPubSub();
    const topic = spaceTopic("at://x/y/z");
    const a = ps.subscribe(topic)[Symbol.asyncIterator]();
    const b = ps.subscribe(topic)[Symbol.asyncIterator]();
    await ps.publish(mk(topic, 42));
    const [ra, rb] = await Promise.all([a.next(), b.next()]);
    expect((ra.value as RealtimeEvent).ts).toBe(42);
    expect((rb.value as RealtimeEvent).ts).toBe(42);
    await a.return?.();
    await b.return?.();
  });

  it("does not cross topics", async () => {
    const ps = new InMemoryPubSub();
    const topic = spaceTopic("at://x/y/z");
    const other = spaceTopic("at://x/y/other");
    const it = ps.subscribe(topic)[Symbol.asyncIterator]();
    await ps.publish(mk(other, 99));
    await ps.publish(mk(topic, 1));
    const r = await it.next();
    expect((r.value as RealtimeEvent).ts).toBe(1);
    await it.return?.();
  });

  it("drops oldest when queue bound is reached", async () => {
    const ps = new InMemoryPubSub({ queueBound: 2 });
    const topic = spaceTopic("at://x/y/z");
    const it = ps.subscribe(topic)[Symbol.asyncIterator]();
    // Fill past the bound before the consumer starts reading.
    for (let i = 1; i <= 5; i++) await ps.publish(mk(topic, i));
    const seen: number[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await it.next();
      seen.push((r.value as RealtimeEvent).ts);
    }
    // Queue bound = 2: the last two events survive (3 was dropped before 4, etc.).
    expect(seen).toEqual([4, 5]);
    await it.return?.();
  });

  it("cleans up subscribers on return()", async () => {
    const ps = new InMemoryPubSub();
    const topic = spaceTopic("at://x/y/z");
    const it = ps.subscribe(topic)[Symbol.asyncIterator]();
    expect(ps.subscriberCount(topic)).toBe(1);
    await it.return?.();
    expect(ps.subscriberCount(topic)).toBe(0);
  });

  it("cleans up subscribers when the abort signal fires", async () => {
    const ps = new InMemoryPubSub();
    const topic = spaceTopic("at://x/y/z");
    const ac = new AbortController();
    const iter = ps.subscribe(topic, ac.signal);
    const it = iter[Symbol.asyncIterator]();
    // Start a pending read, then abort.
    const next = it.next();
    ac.abort();
    const r = await next;
    expect(r.done).toBe(true);
    expect(ps.subscriberCount(topic)).toBe(0);
  });
});

describe("TicketSigner", () => {
  it("round-trips a signed ticket", async () => {
    const signer = new TicketSigner(SECRET);
    const t = await signer.sign({ topics: ["space:a", "space:b"], did: "did:plc:bob", ttlMs: 60_000 });
    const payload = await signer.verify(t);
    expect(payload).not.toBeNull();
    expect(payload!.did).toBe("did:plc:bob");
    expect(payload!.topics).toEqual(["space:a", "space:b"]);
  });

  it("rejects a tampered payload", async () => {
    const signer = new TicketSigner(SECRET);
    const t = await signer.sign({ topics: ["space:a"], did: "did:plc:bob", ttlMs: 60_000 });
    // Replace payload half while keeping original sig — corrupt.
    const tampered = t.replace(/^[^.]+/, "AAAA");
    expect(await signer.verify(tampered)).toBeNull();
  });

  it("rejects signatures from a different secret", async () => {
    const a = new TicketSigner(SECRET);
    const b = new TicketSigner(new Uint8Array(32).fill(4));
    const t = await a.sign({ topics: ["space:a"], did: "did:plc:bob", ttlMs: 60_000 });
    expect(await b.verify(t)).toBeNull();
  });

  it("rejects expired tickets", async () => {
    const signer = new TicketSigner(SECRET);
    const t = await signer.sign({ topics: ["space:a"], did: "did:plc:bob", ttlMs: -1 });
    expect(await signer.verify(t)).toBeNull();
  });

  it("rejects malformed tickets", async () => {
    const signer = new TicketSigner(SECRET);
    expect(await signer.verify("")).toBeNull();
    expect(await signer.verify("nodot")).toBeNull();
    expect(await signer.verify("abc.def")).toBeNull();
  });

  it("accepts secrets as base64 / hex strings", async () => {
    const hex = "03".repeat(32);
    const signer = new TicketSigner(hex);
    const t = await signer.sign({ topics: ["x"], did: "d", ttlMs: 60_000 });
    expect(await signer.verify(t)).not.toBeNull();
  });
});
