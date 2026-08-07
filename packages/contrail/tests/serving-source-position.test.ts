import { describe, expect, it } from "vitest";
import {
  Contrail,
  assertServingSourceCompatibility,
  getLastCursor,
  getServingSourcePosition,
  initSchema,
  saveCursor,
  type ContrailConfig,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const config: ContrailConfig = {
  namespace: "com.example",
  profiles: [],
  orderedSource: { source: "jetstream", epoch: "primary-2026" },
  collections: {
    event: { collection: "com.example.event" },
  },
};

describe("serving source positions", () => {
  it("commits the legacy replay cursor and opaque source position together", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, config);

    await saveCursor(db, 123_456, config.orderedSource);

    expect(await getLastCursor(db)).toBe(123_456);
    expect(await getServingSourcePosition(db)).toMatchObject({
      position: {
        source: "jetstream",
        epoch: "primary-2026",
        cursor: "123456",
      },
    });

    await saveCursor(db, 100, config.orderedSource);
    expect(await getLastCursor(db)).toBe(123_456);
    expect(await getServingSourcePosition(db)).toMatchObject({
      position: { cursor: "123456" },
    });
  });

  it("rejects a configured continuity epoch that differs from durable state", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, config);
    await saveCursor(db, 10, config.orderedSource);

    await expect(
      assertServingSourceCompatibility(db, {
        source: "jetstream",
        epoch: "replacement-epoch",
      }),
    ).rejects.toThrow("does not match durable source position");

    const contrail = new Contrail({
      ...config,
      orderedSource: { source: "jetstream", epoch: "replacement-epoch" },
    });
    await expect(contrail.init(db)).rejects.toThrow(
      "does not match durable source position",
    );
  });

  it("validates ordered source configuration", () => {
    expect(
      () =>
        new Contrail({
          ...config,
          orderedSource: { source: "jetstream", epoch: "" },
        }),
    ).toThrow("orderedSource requires non-empty source and epoch values");
  });
});
