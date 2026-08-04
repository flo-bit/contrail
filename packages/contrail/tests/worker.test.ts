import { describe, it, expect, vi } from "vitest";
import { createWorker } from "../src/worker";
import { Contrail } from "../src/contrail";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import type { ContrailConfig } from "../src/index";

const MINIMAL_CONFIG: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { startsAt: { type: "range" } },
    },
  },
};

describe("createWorker", () => {
  it("returns an object with fetch + scheduled handlers", () => {
    const worker = createWorker(MINIMAL_CONFIG);
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("inits the DB schema lazily on the first fetch (and only once)", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG);
    const env = { DB: db };

    // Before first fetch: schema not present yet.
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursor'")
      .first<{ name: string }>();
    expect(tables).toBeNull();

    await worker.fetch(new Request("http://localhost/health"), env);

    // After first fetch: schema present.
    const after = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursor'")
      .first<{ name: string }>();
    expect(after?.name).toBe("cursor");

    // Second fetch shouldn't re-init (idempotent regardless, but verify
    // onInit fires only once per isolate via a probe).
    const onInit = vi.fn();
    const w2 = createWorker(MINIMAL_CONFIG, { onInit });
    await w2.fetch(new Request("http://localhost/health"), env);
    await w2.fetch(new Request("http://localhost/health"), env);
    await w2.fetch(new Request("http://localhost/health"), env);
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  it("respects a custom binding name", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG, { binding: "MY_DB" });
    const env = { MY_DB: db };

    const res = await worker.fetch(new Request("http://localhost/health"), env);
    expect(res.status).toBe(200);
  });

  it("serves /xrpc/<ns>.lexicons when lexicons are passed", async () => {
    const db = createSqliteDatabase(":memory:");
    const lexicons = [{ lexicon: 1, id: "com.example.foo" }];
    const worker = createWorker(MINIMAL_CONFIG, { lexicons });
    const env = { DB: db };

    const res = await worker.fetch(
      new Request("http://localhost/xrpc/com.example.lexicons"),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lexicons });
  });

  it("does not serve /xrpc/<ns>.lexicons when lexicons are omitted", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG);
    const env = { DB: db };

    const res = await worker.fetch(
      new Request("http://localhost/xrpc/com.example.lexicons"),
      env
    );
    expect(res.status).toBe(404);
  });

  it("scheduled handler runs live ingest then a bounded backfill retry slice", async () => {
    const order: string[] = [];
    const ingest = vi
      .spyOn(Contrail.prototype, "ingest")
      .mockImplementation(async () => {
        order.push("ingest");
      });
    const retry = vi
      .spyOn(Contrail.prototype, "retryBackfill")
      .mockImplementation(async () => {
        order.push("retry");
        return {
          attempted: 0,
          completed: 0,
          failed: 0,
          records: 0,
          skipped: false,
        };
      });

    try {
      const db = createSqliteDatabase(":memory:");
      const worker = createWorker(MINIMAL_CONFIG);
      const env = { DB: db };
      const waitUntil = vi.fn();
      const ctx = {
        waitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      await worker.scheduled({} as ScheduledEvent, env, ctx);

      expect(waitUntil).toHaveBeenCalledTimes(1);
      const scheduled = waitUntil.mock.calls[0][0];
      expect(scheduled).toBeInstanceOf(Promise);
      await scheduled;
      expect(order).toEqual(["ingest", "retry"]);
    } finally {
      ingest.mockRestore();
      retry.mockRestore();
    }
  });
});
