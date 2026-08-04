import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillPending,
  backfillUser,
  createApp,
  discoverDIDs,
  finishBackfillRun,
  getBackfillStatus,
  resolveConfig,
  retryPendingBackfills,
  tryStartBackfillRun
} from "../src/index";
import { __resetPdsCachesForTests } from "../src/core/client";
import { TEST_CONFIG, createTestDbWithSchema, ingestRecords, makeEvent } from "./helpers";

const DID = "did:plc:backfilltest";
const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";

describe("backfill failure state", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetPdsCachesForTests();
  });

  it("does not mark a failed PDS listing complete", async () => {
    const db = await createTestDbWithSchema();
    await db
      .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
      .bind(DID, "backfill.test", "https://pds.test", Date.now())
      .run();

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "UpstreamFailure",
          message: "PDS is unavailable"
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const inserted = await backfillUser(db, DID, EVENT, Infinity, TEST_CONFIG, {
      maxRetries: 0
    });

    expect(inserted).toBe(0);
    const row = await db
      .prepare("SELECT completed, retries, last_error, last_attempt_at, next_retry_at FROM backfills WHERE did = ? AND collection = ?")
      .bind(DID, EVENT)
      .first<{
        completed: number;
        retries: number;
        last_error: string | null;
        last_attempt_at: number | null;
        next_retry_at: number | null;
      }>();
    expect(row?.completed).toBe(0);
    expect(row?.retries).toBe(1);
    expect(row?.last_error).toContain("503");
    expect(row?.last_error).toContain("UpstreamFailure: PDS is unavailable");
    expect(row?.last_attempt_at).toBeTypeOf("number");
    expect(row?.next_retry_at).toBeGreaterThan(Date.now());
  });

  it("retries pending rows on the next run and only then completes them", async () => {
    const db = await createTestDbWithSchema();
    await db
      .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
      .bind(DID, "backfill.test", "https://pds.test", Date.now())
      .run();
    await db.prepare("INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0)").bind(DID, EVENT).run();

    fetchSpy.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const failedProgress: Array<{
      usersComplete: number;
      usersFailed: number;
    }> = [];
    await backfillPending(db, TEST_CONFIG, {
      concurrency: 1,
      maxAttempts: 1,
      onProgress: ({ usersComplete, usersFailed }) => failedProgress.push({ usersComplete, usersFailed })
    });

    expect(failedProgress.at(-1)).toEqual({
      usersComplete: 0,
      usersFailed: 1
    });
    expect((await getBackfillStatus(db)).accounts).toEqual({
      total: 1,
      complete: 0,
      pending: 0,
      retrying: 1,
      failed: 0
    });

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    await backfillPending(db, TEST_CONFIG, {
      concurrency: 1,
      maxAttempts: 1
    });

    const status = await getBackfillStatus(db);
    expect(status.state).toBe("complete");
    expect(status.accounts).toEqual({
      total: 1,
      complete: 1,
      pending: 0,
      retrying: 0,
      failed: 0
    });
  });
});

describe("scheduled backfill retries", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetPdsCachesForTests();
  });

  it("waits for persisted backoff and then completes a due account", async () => {
    const db = await createTestDbWithSchema();
    await db
      .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
      .bind(DID, "backfill.test", "https://pds.test", Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed, retries, last_error, next_retry_at) VALUES (?, ?, 0, 1, 'unavailable', ?)"
      )
      .bind(DID, EVENT, Date.now() + 60_000)
      .run();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    expect(
      await retryPendingBackfills(db, TEST_CONFIG, { maxAccounts: 1 })
    ).toMatchObject({ attempted: 0, completed: 0, skipped: false });

    await db
      .prepare("UPDATE backfills SET next_retry_at = ? WHERE did = ?")
      .bind(Date.now() - 1, DID)
      .run();
    expect(
      await retryPendingBackfills(db, TEST_CONFIG, { maxAccounts: 1 })
    ).toMatchObject({ attempted: 1, completed: 1, failed: 0, skipped: false });

    const row = await db
      .prepare("SELECT completed, retries, last_error, next_retry_at FROM backfills WHERE did = ?")
      .bind(DID)
      .first<{
        completed: number;
        retries: number;
        last_error: string | null;
        next_retry_at: number | null;
      }>();
    expect(row).toEqual({
      completed: 1,
      retries: 0,
      last_error: null,
      next_retry_at: null
    });
  });

  it("caps backoff at 48 hours and stops after ten failures", async () => {
    const db = await createTestDbWithSchema();
    await db
      .prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
      .bind(DID, "backfill.test", "https://pds.test", Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed, retries, scheduled_retries, last_error, next_retry_at) VALUES (?, ?, 0, 8, 8, 'unavailable', ?)"
      )
      .bind(DID, EVENT, Date.now() - 1)
      .run();
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Unavailable", message: "try later" }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const before = Date.now();
    await retryPendingBackfills(db, TEST_CONFIG, {
      maxAccounts: 1,
      maxAttempts: 10
    });
    let row = await db
      .prepare("SELECT retries, scheduled_retries, next_retry_at, retry_exhausted FROM backfills WHERE did = ?")
      .bind(DID)
      .first<{
        retries: number;
        scheduled_retries: number;
        next_retry_at: number | null;
        retry_exhausted: number;
      }>();
    expect(row?.retries).toBe(9);
    expect(row?.scheduled_retries).toBe(9);
    expect(row?.retry_exhausted).toBe(0);
    expect(row?.next_retry_at).toBeGreaterThanOrEqual(
      before + 48 * 60 * 60_000
    );
    expect(row?.next_retry_at).toBeLessThanOrEqual(
      Date.now() + 48 * 60 * 60_000
    );

    await db
      .prepare("UPDATE backfills SET next_retry_at = ? WHERE did = ?")
      .bind(Date.now() - 1, DID)
      .run();
    await retryPendingBackfills(db, TEST_CONFIG, {
      maxAccounts: 1,
      maxAttempts: 10
    });
    row = await db
      .prepare("SELECT retries, scheduled_retries, next_retry_at, retry_exhausted FROM backfills WHERE did = ?")
      .bind(DID)
      .first<{
        retries: number;
        scheduled_retries: number;
        next_retry_at: number | null;
        retry_exhausted: number;
      }>();
    expect(row).toEqual({
      retries: 10,
      scheduled_retries: 10,
      next_retry_at: null,
      retry_exhausted: 1
    });
    expect((await getBackfillStatus(db, TEST_CONFIG)).accounts).toEqual({
      total: 1,
      complete: 0,
      pending: 0,
      retrying: 0,
      failed: 1
    });

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    await backfillPending(db, TEST_CONFIG, { maxAttempts: 1 });
    expect((await getBackfillStatus(db, TEST_CONFIG)).accounts.complete).toBe(1);
  });

  it("reports an active run and prevents overlapping retry work", async () => {
    const db = await createTestDbWithSchema();
    const runId = await tryStartBackfillRun(db);
    expect(runId).not.toBeNull();
    expect((await getBackfillStatus(db, TEST_CONFIG)).state).toBe("running");

    expect(await retryPendingBackfills(db, TEST_CONFIG)).toEqual({
      attempted: 0,
      completed: 0,
      failed: 0,
      records: 0,
      skipped: true
    });

    await finishBackfillRun(db, runId!);
    expect((await getBackfillStatus(db, TEST_CONFIG)).state).toBe("not_started");
  });
});

describe("discovery failure state", () => {
  it("keeps a failed relay pending and falls back to another relay", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://relay-a.test")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ repos: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    try {
      const db = await createTestDbWithSchema();
      const config = resolveConfig({
        namespace: "com.example",
        collections: { event: { collection: EVENT } },
        relays: ["https://relay-a.test", "https://relay-b.test"]
      });

      const discovery = discoverDIDs(db, config, Infinity);
      await vi.runAllTimersAsync();
      await discovery;

      const rows = await db
        .prepare("SELECT relay, completed, retries, last_error, next_retry_at FROM discovery ORDER BY relay")
        .all<{
          relay: string;
          completed: number;
          retries: number;
          last_error: string | null;
          next_retry_at: number | null;
        }>();
      expect(rows.results).toEqual([
        expect.objectContaining({
          relay: "https://relay-a.test",
          completed: 0,
          retries: 1,
          last_error: expect.stringContaining("503"),
          next_retry_at: expect.any(Number)
        }),
        {
          relay: "https://relay-b.test",
          completed: 1,
          retries: 0,
          last_error: null,
          next_retry_at: null
        }
      ]);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("backfill status JSON", () => {
  it("reports the initial pass complete while failed accounts remain scheduled", async () => {
    const db = await createTestDbWithSchema();
    const retryAt = Date.now() + 60_000;
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed, retries, last_error, next_retry_at) VALUES (?, ?, 0, 1, 'unavailable', ?)"
      )
      .bind(DID, EVENT, retryAt)
      .run();
    await db
      .prepare(
        "INSERT INTO discovery (collection, relay, completed) VALUES (?, 'https://relay.test', 1)"
      )
      .bind(EVENT)
      .run();

    const status = await getBackfillStatus(db, TEST_CONFIG);
    expect(status.state).toBe("complete");
    expect(status.accounts).toEqual({
      total: 1,
      complete: 0,
      pending: 0,
      retrying: 1,
      failed: 0
    });
    expect(status.retries).toEqual({
      scheduled_accounts: 1,
      due_accounts: 0,
      next_retry_at: retryAt,
      next_retry_date: new Date(retryAt).toISOString()
    });
  });

  it("reports mutually exclusive account and collection states", async () => {
    const db = await createTestDbWithSchema();
    await ingestRecords(db, [makeEvent()]);
    await db
      .prepare("INSERT INTO cursor (id, time_us) VALUES (1, ?)")
      .bind(Date.now() * 1_000)
      .run();
    await db
      .prepare(
        `INSERT INTO backfills (did, collection, completed, last_error) VALUES
          ('did:plc:a', ?, 1, NULL),
          ('did:plc:a', ?, 1, NULL),
          ('did:plc:b', ?, 0, 'PDS unavailable'),
          ('did:plc:b', ?, 0, NULL),
          ('did:plc:c', ?, 0, NULL)`
      )
      .bind(EVENT, RSVP, EVENT, RSVP, EVENT)
      .run();
    await db
      .prepare(
        `INSERT INTO discovery (collection, relay, completed, last_error) VALUES
          (?, 'https://relay-a.test', 1, NULL),
          (?, 'https://relay-b.test', 0, 'HTTP 503')`
      )
      .bind(EVENT, EVENT)
      .run();

    const app = createApp(db, TEST_CONFIG);
    const response = await app.fetch(new Request("http://localhost/status"));
    expect(response.status).toBe(200);
    const overview = (await response.json()) as any;

    expect(overview.status).toBe("ok");
    expect(overview.total_records).toBe(1);
    expect(overview.ingestion.cursor).toBeTypeOf("number");
    expect(overview.backfill).toMatchObject({
      state: "incomplete",
      known_progress_percent: 33.33,
      accounts: {
        total: 3,
        complete: 1,
        pending: 1,
        retrying: 1,
        failed: 0
      },
      discovery: {
        total: 2,
        complete: 1,
        pending: 0,
        retrying: 1,
        failed: 0
      },
      retries: {
        scheduled_accounts: 1,
        due_accounts: 1,
        next_retry_at: null,
        next_retry_date: null
      }
    });
    expect(JSON.stringify(overview)).not.toContain("did:plc:b");
    expect(JSON.stringify(overview)).not.toContain("PDS unavailable");
    expect(overview.backfill.collections).toEqual([
      {
        collection: EVENT,
        total: 3,
        complete: 1,
        pending: 1,
        retrying: 1,
        failed: 0
      },
      {
        collection: RSVP,
        total: 2,
        complete: 1,
        pending: 1,
        retrying: 0,
        failed: 0
      }
    ]);

    const root = await app.fetch(new Request("http://localhost/"));
    expect(await root.json()).toEqual({ status: "ok" });

    const xrpc = await app.fetch(new Request("http://localhost/xrpc/com.example.getOverview"));
    expect(((await xrpc.json()) as any).backfill).toEqual(overview.backfill);
  });
});
