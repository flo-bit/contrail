import { describe, it, expect, vi } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema, optimizeDatabase, getMetaNumber } from "../src/core/db";
import { maybeOptimize } from "../src/core/jetstream";
import { resolveConfig } from "../src/core/types";

const BASE = {
  namespace: "com.example",
  collections: { event: { collection: "com.example.event" } },
};

function silentLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function freshDb(config = resolveConfig(BASE)) {
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
  return db;
}

describe("optimizeDatabase", () => {
  it("runs PRAGMA optimize on sqlite without error", async () => {
    const db = await freshDb();
    await expect(optimizeDatabase(db, 400)).resolves.toBeUndefined();
  });

  it("tolerates an unusual analysis_limit", async () => {
    const db = await freshDb();
    await expect(optimizeDatabase(db, 0)).resolves.toBeUndefined();
  });
});

describe("maybeOptimize gating", () => {
  it("is a no-op when maintenance.optimize is unset", async () => {
    const cfg = resolveConfig(BASE);
    const db = await freshDb(cfg);
    await maybeOptimize(db, cfg, silentLogger());
    expect(await getMetaNumber(db, "optimize_last_ms")).toBeNull();
  });

  it("runs and persists the timestamp when enabled and due", async () => {
    const cfg = resolveConfig({ ...BASE, maintenance: { optimize: true } });
    const db = await freshDb(cfg);
    await maybeOptimize(db, cfg, silentLogger());
    expect(await getMetaNumber(db, "optimize_last_ms")).toBeGreaterThan(0);
  });

  it("skips while within the interval", async () => {
    const cfg = resolveConfig({
      ...BASE,
      maintenance: { optimize: { intervalMs: 1_000_000 } },
    });
    const db = await freshDb(cfg);

    await maybeOptimize(db, cfg, silentLogger());
    const ts1 = await getMetaNumber(db, "optimize_last_ms");
    expect(ts1).toBeGreaterThan(0);

    await maybeOptimize(db, cfg, silentLogger());
    const ts2 = await getMetaNumber(db, "optimize_last_ms");
    expect(ts2).toBe(ts1); // not re-run within the interval
  });

  it("claims the interval up front even if optimize throws", async () => {
    const cfg = resolveConfig({ ...BASE, maintenance: { optimize: true } });
    const db = await freshDb(cfg);

    // Force the optimize itself to fail; the cadence timestamp must still be
    // written so a broken/unsupported pragma can't re-run every tick.
    const orig = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/PRAGMA optimize/i.test(sql)) throw new Error("pragma unsupported");
      return orig(sql);
    };
    const log = silentLogger();

    await maybeOptimize(db, cfg, log);

    expect(await getMetaNumber(db, "optimize_last_ms")).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalled();
  });
});
