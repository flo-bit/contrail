/** End-to-end router checks for label hydration:
 *  - `listRecords` attaches `record.labels` and echoes `atproto-content-labelers`
 *  - `getRecord` does the same for a single record
 *  - caller-provided `?labelers=` overrides config defaults
 *  - unaccepted labelers are dropped */
import { describe, it, expect } from "vitest";
import { Contrail } from "../src/contrail";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { applyEvents } from "../src/core/db/records";
import { applyLabels } from "../src/core/labels/apply";
import type { IngestEvent } from "../src/core/types";

const COLL = "com.example.event";
const SRC_A = "did:plc:labelerA";
const SRC_B = "did:plc:labelerB";
const AUTHOR = "did:plc:author";
const RKEY = "abc";
const URI = `at://${AUTHOR}/${COLL}/${RKEY}`;

function ev(): IngestEvent {
  const now = Date.now() * 1000;
  return {
    uri: URI,
    did: AUTHOR,
    collection: COLL,
    rkey: RKEY,
    operation: "create",
    cid: "bafy-1",
    record: JSON.stringify({ name: "test" }),
    time_us: now,
    indexed_at: now,
  };
}

async function setup() {
  const db = createSqliteDatabase(":memory:");
  const contrail = new Contrail({
    namespace: "ex",
    collections: { event: { collection: COLL } },
    labels: {
      sources: [{ did: SRC_A }, { did: SRC_B }],
      defaults: [SRC_A], // SRC_B is opt-in via caller
    },
    db,
  });
  await contrail.init();
  await applyEvents(db, [ev()], contrail.config);
  await applyLabels(db, [
    { src: SRC_A, uri: URI, val: "spam", cts: new Date().toISOString() },
    { src: SRC_B, uri: URI, val: "porn", cts: new Date().toISOString() },
  ]);
  return { db, contrail };
}

describe("labels router integration", () => {
  it("listRecords attaches labels and echoes atproto-content-labelers", async () => {
    const { contrail } = await setup();
    const app = contrail.app();

    const res = await app.fetch(new Request(`http://localhost/xrpc/ex.event.listRecords`));
    expect(res.status).toBe(200);

    expect(res.headers.get("atproto-content-labelers")).toBe(SRC_A);

    const body = (await res.json()) as { records: Array<{ uri: string; labels?: any[] }> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.labels).toBeDefined();
    expect(body.records[0]!.labels!.map((l: any) => l.val)).toEqual(["spam"]);
  });

  it("getRecord attaches labels for a single record", async () => {
    const { contrail } = await setup();
    const app = contrail.app();

    const res = await app.fetch(
      new Request(`http://localhost/xrpc/ex.event.getRecord?uri=${encodeURIComponent(URI)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("atproto-content-labelers")).toBe(SRC_A);

    const body = (await res.json()) as { uri: string; labels?: any[] };
    expect(body.labels?.map((l: any) => l.val)).toEqual(["spam"]);
  });

  it("?labelers= override pulls from a non-default source", async () => {
    const { contrail } = await setup();
    const app = contrail.app();

    const res = await app.fetch(
      new Request(`http://localhost/xrpc/ex.event.listRecords?labelers=${SRC_B}`),
    );
    expect(res.headers.get("atproto-content-labelers")).toBe(SRC_B);
    const body = (await res.json()) as { records: Array<{ labels?: any[] }> };
    expect(body.records[0]!.labels?.map((l: any) => l.val)).toEqual(["porn"]);
  });

  it("atproto-accept-labelers header takes precedence over query param", async () => {
    const { contrail } = await setup();
    const app = contrail.app();

    const res = await app.fetch(
      new Request(`http://localhost/xrpc/ex.event.listRecords?labelers=${SRC_B}`, {
        headers: { "atproto-accept-labelers": SRC_A },
      }),
    );
    expect(res.headers.get("atproto-content-labelers")).toBe(SRC_A);
    const body = (await res.json()) as { records: Array<{ labels?: any[] }> };
    expect(body.records[0]!.labels?.map((l: any) => l.val)).toEqual(["spam"]);
  });

  it("when no labels are configured, no header and no field", async () => {
    const db = createSqliteDatabase(":memory:");
    const contrail = new Contrail({
      namespace: "ex",
      collections: { event: { collection: COLL } },
      // no labels: {} block
      db,
    });
    await contrail.init();
    await applyEvents(db, [ev()], contrail.config);
    const app = contrail.app();

    const res = await app.fetch(new Request(`http://localhost/xrpc/ex.event.listRecords`));
    expect(res.status).toBe(200);
    expect(res.headers.get("atproto-content-labelers")).toBeNull();
    const body = (await res.json()) as { records: Array<{ labels?: any[] }> };
    expect(body.records[0]!.labels).toBeUndefined();
  });

  it("unknown caller-supplied DIDs are dropped (allowUserSupplied off)", async () => {
    const { contrail } = await setup();
    const app = contrail.app();

    const res = await app.fetch(
      new Request(`http://localhost/xrpc/ex.event.listRecords?labelers=did:plc:bogus`),
    );
    expect(res.headers.get("atproto-content-labelers")).toBeNull();
    const body = (await res.json()) as { records: Array<{ labels?: any[] }> };
    expect(body.records[0]!.labels).toBeUndefined();
  });
});
