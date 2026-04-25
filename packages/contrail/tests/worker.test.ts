import { describe, it, expect, vi } from "vitest";
import { createWorker } from "../src/worker";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import type { ContrailConfig } from "../src/core/types";

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

  it("scheduled handler hands the ingest promise to ctx.waitUntil", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG);
    const env = { DB: db };

    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;

    // Schedule returns once init + waitUntil have been called. The actual
    // ingest is a long-running promise that would try to connect to a real
    // Jetstream — we don't drain it; we just verify the wire-up.
    await worker.scheduled({} as ScheduledEvent, env, ctx);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});
