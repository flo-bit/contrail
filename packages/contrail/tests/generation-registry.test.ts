import { describe, expect, it } from "vitest";
import {
  DatabaseGenerationRegistry,
  initGenerationRegistry,
  type GenerationReadiness,
  type GenerationTuple,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

function tuple(id: string): GenerationTuple {
  return {
    id,
    codeDigest: `code-${id}`,
    definitionDigest: `definition-${id}`,
    databaseLocator: `database-${id}`,
    schemaVersion: 9,
  };
}

function readiness(cursor: string): GenerationReadiness {
  return {
    through: { source: "jetstream", epoch: "epoch-one", cursor },
    verification: {
      ok: true,
      verifiedAt: Date.now(),
      checks: [
        { name: "snapshot-partitions", ok: true, failures: 0 },
        { name: "visible-version:event", ok: true, failures: 0 },
      ],
    },
  };
}

describe("database generation registry", () => {
  it("atomically activates complete tuples and keeps the previous one for rollback", async () => {
    const db = createSqliteDatabase(":memory:");
    await initGenerationRegistry(db);
    const registry = new DatabaseGenerationRegistry(db);

    expect((await registry.registerCandidate(tuple("one"))).state).toBe(
      "candidate",
    );
    expect((await registry.markReady("one", readiness("10"))).state).toBe(
      "ready",
    );
    const first = await registry.activate("one", null);
    expect(first.previous).toBeNull();
    expect(first.active).toMatchObject({
      state: "active",
      tuple: tuple("one"),
    });

    await registry.registerCandidate(tuple("two"));
    await registry.markReady("two", readiness("20"));
    const second = await registry.activate("two", "one");
    expect(second.previous?.tuple.id).toBe("one");
    expect(second.active.tuple).toEqual(tuple("two"));
    expect((await registry.get("one"))?.state).toBe("retained");
    expect((await registry.active())?.tuple).toEqual(tuple("two"));

    const rollback = await registry.activate("one", "two");
    expect(rollback.previous?.tuple.id).toBe("two");
    expect(rollback.active.tuple.id).toBe("one");
    expect((await registry.get("two"))?.state).toBe("retained");

    await registry.retire("two");
    expect((await registry.get("two"))?.state).toBe("retired");
    expect((await registry.active())?.tuple.id).toBe("one");
  });

  it("rejects stale, incomplete, retired, and tuple-changing activations", async () => {
    const db = createSqliteDatabase(":memory:");
    await initGenerationRegistry(db);
    const registry = new DatabaseGenerationRegistry(db);
    await registry.registerCandidate(tuple("one"));
    await registry.markReady("one", readiness("10"));
    await registry.activate("one", null);

    await expect(registry.activate("one", null)).rejects.toThrow(
      "changed before activation",
    );
    await expect(registry.retire("one")).rejects.toThrow("cannot be retired");

    await registry.registerCandidate(tuple("candidate"));
    await expect(registry.activate("candidate", "one")).rejects.toThrow(
      "not ready",
    );
    expect((await registry.active())?.tuple.id).toBe("one");

    await expect(
      registry.registerCandidate({
        ...tuple("one"),
        databaseLocator: "another-database",
      }),
    ).rejects.toThrow("already names another tuple");

    await registry.retire("candidate");
    await expect(
      registry.markReady("candidate", readiness("30")),
    ).rejects.toThrow("cannot become ready");
  });

  it("requires a successful aggregate verification proof before readiness", async () => {
    const db = createSqliteDatabase(":memory:");
    await initGenerationRegistry(db);
    const registry = new DatabaseGenerationRegistry(db);
    await registry.registerCandidate(tuple("failed"));
    const proof = readiness("10");
    proof.verification.ok = false;
    proof.verification.checks[0] = {
      name: "snapshot-partitions",
      ok: false,
      failures: 1,
    };

    await expect(registry.markReady("failed", proof)).rejects.toThrow(
      "failed bootstrap verification",
    );
    expect((await registry.get("failed"))?.state).toBe("candidate");
  });
});
