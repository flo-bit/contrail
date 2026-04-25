import { describe, it, expect, vi, beforeEach } from "vitest";
import { refresh } from "../src/core/refresh";
import { applyEvents, createTestDbWithSchema, makeEvent, TEST_CONFIG } from "./helpers";
import type { Database } from "../src/core/types";

// We mock the PDS client so refresh() can be exercised without network IO.
// Each test sets the desired pageRecords for a given (did, collection) via
// the `pages` map below.
const pages = new Map<string, Array<{ uri: string; cid: string; value: object }>>();

vi.mock("../src/core/client", () => ({
  getClient: vi.fn(async (did: string) => ({
    get: async (
      _method: string,
      opts: { params: { repo: string; collection: string; cursor?: string } }
    ) => {
      const key = `${opts.params.repo}|${opts.params.collection}`;
      // Single page per (did, collection); cursor triggers empty page = done.
      if (opts.params.cursor) return { ok: true, data: { records: [], cursor: undefined } };
      const records = pages.get(key) ?? [];
      return { ok: true, data: { records, cursor: undefined } };
    },
  })),
  getPDS: vi.fn(),
}));

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const EVENT_NSID = "community.lexicon.calendar.event";

function aliceEventUri(rkey: string): string {
  return `at://${ALICE}/${EVENT_NSID}/${rkey}`;
}

async function registerKnownDid(db: Database, did: string): Promise<void> {
  // refresh() enumerates DIDs from the `backfills` table.
  await db
    .prepare(
      "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 1) ON CONFLICT DO NOTHING"
    )
    .bind(did, EVENT_NSID)
    .run();
}

describe("refresh", () => {
  beforeEach(() => {
    pages.clear();
  });

  it("classifies an unseen-by-DB record as missing", async () => {
    const db = await createTestDbWithSchema();
    await registerKnownDid(db, ALICE);

    pages.set(`${ALICE}|${EVENT_NSID}`, [
      {
        uri: aliceEventUri("new1"),
        cid: "bafy-new",
        value: { name: "Brand new", startsAt: "2026-04-01T10:00:00Z" },
      },
    ]);

    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 0 });
    expect(result.total.missing).toBe(1);
    expect(result.total.staleUpdates).toBe(0);
    expect(result.total.inSync).toBe(0);
    expect(result.usersScanned).toBe(1);
  });

  it("classifies a same-CID record as in-sync", async () => {
    const db = await createTestDbWithSchema();
    await registerKnownDid(db, ALICE);

    // Seed DB with a record at this URI.
    await applyEvents(db, [
      makeEvent({
        did: ALICE,
        rkey: "k1",
        uri: aliceEventUri("k1"),
        cid: "bafy-same",
        record: { name: "Already here" },
      }),
    ]);

    // PDS returns same URI + same CID.
    pages.set(`${ALICE}|${EVENT_NSID}`, [
      { uri: aliceEventUri("k1"), cid: "bafy-same", value: { name: "Already here" } },
    ]);

    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 0 });
    expect(result.total.missing).toBe(0);
    expect(result.total.staleUpdates).toBe(0);
    expect(result.total.inSync).toBe(1);
  });

  it("classifies a different-CID record as a stale update (outside ignore window)", async () => {
    const db = await createTestDbWithSchema();
    await registerKnownDid(db, ALICE);

    // Seed DB with an OLD record (indexed_at way in the past).
    const dayAgoUs = (Date.now() - 86_400_000) * 1000;
    await applyEvents(db, [
      makeEvent({
        did: ALICE,
        rkey: "k2",
        uri: aliceEventUri("k2"),
        cid: "bafy-old",
        time_us: dayAgoUs,
        indexed_at: dayAgoUs,
        record: { name: "Was online" },
      }),
    ]);

    // PDS returns same URI but different CID.
    pages.set(`${ALICE}|${EVENT_NSID}`, [
      { uri: aliceEventUri("k2"), cid: "bafy-NEW", value: { name: "Now in-person" } },
    ]);

    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 60_000 });
    expect(result.total.staleUpdates).toBe(1);
    expect(result.total.missing).toBe(0);
    expect(result.total.inSync).toBe(0);
  });

  it("skips stale-update classification when DB row is within the ignore window", async () => {
    const db = await createTestDbWithSchema();
    await registerKnownDid(db, ALICE);

    // Seed with a record indexed JUST NOW.
    const nowUs = Date.now() * 1000;
    await applyEvents(db, [
      makeEvent({
        did: ALICE,
        rkey: "k3",
        uri: aliceEventUri("k3"),
        cid: "bafy-recent",
        time_us: nowUs,
        indexed_at: nowUs,
        record: { name: "Recent" },
      }),
    ]);

    // PDS returns different CID — but DB row is fresh, so it counts as in-sync.
    pages.set(`${ALICE}|${EVENT_NSID}`, [
      { uri: aliceEventUri("k3"), cid: "bafy-different", value: { name: "Recent v2" } },
    ]);

    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 60_000 });
    expect(result.total.staleUpdates).toBe(0);
    expect(result.total.inSync).toBe(1);
  });

  it("aggregates stats per collection", async () => {
    const db = await createTestDbWithSchema();
    await registerKnownDid(db, ALICE);
    await registerKnownDid(db, BOB);

    pages.set(`${ALICE}|${EVENT_NSID}`, [
      { uri: aliceEventUri("a1"), cid: "x", value: {} },
      { uri: aliceEventUri("a2"), cid: "y", value: {} },
    ]);
    pages.set(`${BOB}|${EVENT_NSID}`, [
      { uri: `at://${BOB}/${EVENT_NSID}/b1`, cid: "z", value: {} },
    ]);

    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 0 });
    expect(result.byCollection[EVENT_NSID]).toBeDefined();
    expect(result.byCollection[EVENT_NSID].missing).toBe(3);
    expect(result.usersScanned).toBe(2);
  });

  it("counts a user as failed when getClient throws, and continues with others", async () => {
    const { getClient } = await import("../src/core/client");
    (getClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error("PDS unreachable");
      }
    );

    const db = await createTestDbWithSchema();
    await registerKnownDid(db, ALICE);
    await registerKnownDid(db, BOB);
    pages.set(`${BOB}|${EVENT_NSID}`, [
      { uri: `at://${BOB}/${EVENT_NSID}/x`, cid: "c", value: {} },
    ]);

    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 0, concurrency: 1 });
    expect(result.usersFailed).toBe(1);
    expect(result.usersScanned).toBe(1);
    // The non-failing user's records still classified.
    expect(result.total.missing).toBeGreaterThanOrEqual(1);
  });

  it("returns elapsed time and the configured ignore window", async () => {
    const db = await createTestDbWithSchema();
    const result = await refresh(db, TEST_CONFIG, { ignoreWindowMs: 30_000 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.ignoreWindowMs).toBe(30_000);
  });
});
