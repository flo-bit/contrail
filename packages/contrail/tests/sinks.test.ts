/** Sinks — write-only, post-commit observers fanned out by `applyEvents`.
 *
 *   - One deduplicated event per record (not the realtime collection:/actor: pair).
 *   - Fire on the live path by default and on backfill when `phase` says so.
 *   - Failures are isolated: a throwing sink blocks neither the DB commit nor
 *     the other sinks, and is logged.
 *   - Public-record scope: space-scoped records publish via the publishing
 *     adapter and never reach `applyEvents`, so a sink cannot observe them. */

import { describe, it, expect } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { applyEvents, queryRecords } from "../src/core/db/records";
import { resolveConfig } from "../src/core/types";
import type {
  ContrailConfig,
  IngestEvent,
  RecordEvent,
  Sink,
  SinkContext,
} from "../src/core/types";

const ALICE = "did:plc:alice";
const EVENT_NSID = "community.lexicon.calendar.event";
const EVENT_URI = `at://${ALICE}/${EVENT_NSID}/abc`;

/** Captures every onRecords call for assertions. */
class RecordingSink implements Sink {
  calls: { events: RecordEvent[]; ctx: SinkContext }[] = [];
  async onRecords(events: RecordEvent[], ctx: SinkContext): Promise<void> {
    this.calls.push({ events, ctx });
  }
}

function configWithSinks(sinks: Sink[]): ContrailConfig {
  return resolveConfig({
    namespace: "test.sinks",
    collections: { event: { collection: EVENT_NSID } },
    sinks,
  });
}

function createEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    uri: EVENT_URI,
    did: ALICE,
    collection: EVENT_NSID,
    rkey: "abc",
    operation: "create",
    cid: "bafytest",
    record: JSON.stringify({ name: "Launch party" }),
    time_us: 1_700_000_000_000_000,
    indexed_at: 1_700_000_000_000,
    ...overrides,
  };
}

async function freshDb(config: ContrailConfig) {
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
  return db;
}

describe("sinks — applyEvents fan-out", () => {
  it("delivers one deduplicated created event per record, phase=live by default", async () => {
    const sink = new RecordingSink();
    const config = configWithSinks([sink]);
    const db = await freshDb(config);

    await applyEvents(db, [createEvent()], config);

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].ctx.phase).toBe("live");
    // One event per record — not the collection:/actor: pair the realtime
    // pubsub emits.
    expect(sink.calls[0].events).toHaveLength(1);
    expect(sink.calls[0].events[0]).toMatchObject({
      kind: "created",
      uri: EVENT_URI,
      did: ALICE,
      collection: EVENT_NSID,
      rkey: "abc",
      cid: "bafytest",
      record: { name: "Launch party" },
    });
  });

  it("delivers deleted events carrying identity only", async () => {
    const sink = new RecordingSink();
    const config = configWithSinks([sink]);
    const db = await freshDb(config);

    await applyEvents(db, [createEvent()], config);
    await applyEvents(db, [createEvent({ operation: "delete" })], config);

    expect(sink.calls).toHaveLength(2);
    expect(sink.calls[1].events[0]).toEqual({
      kind: "deleted",
      uri: EVENT_URI,
      did: ALICE,
      collection: EVENT_NSID,
      rkey: "abc",
    });
  });

  it("forwards phase=backfill", async () => {
    const sink = new RecordingSink();
    const config = configWithSinks([sink]);
    const db = await freshDb(config);

    await applyEvents(db, [createEvent()], config, { phase: "backfill" });

    expect(sink.calls[0].ctx.phase).toBe("backfill");
  });

  it("fans out to multiple sinks without nesting", async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    const config = configWithSinks([a, b]);
    const db = await freshDb(config);

    await applyEvents(db, [createEvent()], config);

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("isolates a throwing sink: the record still commits and other sinks still fire", async () => {
    const errors: unknown[][] = [];
    const throwing: Sink = {
      onRecords() {
        throw new Error("boom");
      },
    };
    const after = new RecordingSink();
    const config = configWithSinks([throwing, after]);
    config.logger = {
      log() {},
      warn() {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };
    const db = await freshDb(config);

    await applyEvents(db, [createEvent()], config);

    // The throw blocked neither the later sink...
    expect(after.calls).toHaveLength(1);
    // ...nor the DB commit...
    const result = await queryRecords(db, config, { collection: EVENT_NSID });
    expect(result.records).toHaveLength(1);
    // ...and the failure was logged, not propagated.
    expect(errors).toHaveLength(1);
  });

  it("does not fire when there are no events", async () => {
    const sink = new RecordingSink();
    const config = configWithSinks([sink]);
    const db = await freshDb(config);

    await applyEvents(db, [], config);

    expect(sink.calls).toHaveLength(0);
  });
});
