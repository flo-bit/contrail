import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseBootstrapTarget,
  PdsSnapshotIncompleteError,
  PdsSnapshotSource,
  bootstrapFreshProjection,
  initSchema,
  queryRecords,
  resolveConfig,
  type ChangeSource,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { __resetPdsCachesForTests } from "../src/core/client";

const DID = "did:plc:pds-snapshot";
const COLLECTION = "com.example.event";

function config() {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    constellation: false,
    relays: ["https://relay.test"],
    networkOverrides: { additionalAllowedHosts: ["pds.allowed.test"] },
    collections: { event: { collection: COLLECTION } },
  });
}

describe("PDS snapshot source", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPdsCachesForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetPdsCachesForTests();
  });

  it("discovers partitions and resumes listRecords from committed partition progress", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(DID, "snapshot.test", "https://pds.allowed.test", Date.now())
      .run();

    const requestedCursors: Array<string | null> = [];
    fetchSpy.mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "relay.test") {
        return new Response(JSON.stringify({ repos: [{ did: DID }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.hostname === "pds.allowed.test") {
        const cursor = url.searchParams.get("cursor");
        requestedCursors.push(cursor);
        const suffix = cursor === null ? "one" : "two";
        return new Response(
          JSON.stringify({
            records: [
              {
                uri: `at://${DID}/${COLLECTION}/${suffix}`,
                cid: `cid-${suffix}`,
                value: { $type: COLLECTION, name: suffix },
              },
            ],
            ...(cursor === null ? { cursor: "next-page" } : {}),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const source = new PdsSnapshotSource(db, resolved, {
      maxRetries: 0,
    });
    const prepared = await source.prepare({ collections: [COLLECTION] });
    const firstRead = source.read({ snapshot: prepared })[Symbol.asyncIterator]();
    const first = await firstRead.next();
    expect(first.done).toBe(false);
    expect(first.value.records.map((record) => record.rkey)).toEqual(["one"]);
    expect(first.value.progress).toEqual({
      partition: JSON.stringify([DID, COLLECTION]),
      cursor: "next-page",
      complete: false,
    });
    expect(first.value.done).toBe(false);
    await firstRead.return?.();

    const resumed = [];
    for await (const batch of source.read({
      snapshot: prepared,
      progress: [first.value.progress],
    })) {
      resumed.push(batch);
    }

    expect(requestedCursors).toEqual([null, "next-page"]);
    expect(resumed).toHaveLength(2);
    expect(resumed[0].records.map((record) => record.rkey)).toEqual(["two"]);
    expect(resumed[0].progress).toEqual({
      partition: JSON.stringify([DID, COLLECTION]),
      cursor: null,
      complete: true,
    });
    expect(resumed[0].done).toBe(false);
    expect(resumed[1]).toMatchObject({
      records: [],
      progress: { partition: "snapshot", cursor: null, complete: true },
      done: true,
    });
  });

  it("builds a database candidate and replays changes after capture-first discovery", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(DID, "snapshot.test", "https://pds.allowed.test", Date.now())
      .run();

    const calls: string[] = [];
    fetchSpy.mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "relay.test") {
        calls.push("relay");
        return new Response(JSON.stringify({ repos: [{ did: DID }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push("pds");
      return new Response(
        JSON.stringify({
          records: [
            {
              uri: `at://${DID}/${COLLECTION}/candidate`,
              cid: "bafyreiclp443lav4udnztz7msp6j2wkxwp4m5mns2njm6zq7so4au6druq",
              value: { $type: COLLECTION, name: "snapshot" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const base = Date.now() * 1000;
    let marks = 0;
    const changes: ChangeSource = {
      id: "test-changes",
      semantics: {
        ordinaryRecords: true,
        ordinaryDeletes: true,
        accountLifecycle: false,
        repositoryReplacement: false,
        verifiedCommits: false,
        explicitHead: true,
      },
      async mark() {
        marks++;
        calls.push(`mark:${marks}`);
        return {
          source: "test-changes",
          epoch: "one",
          cursor: String(base + (marks === 1 ? 0 : 2_000_000)),
        };
      },
      async *read({ through }) {
        calls.push("changes");
        yield {
          mutations: [
            {
              operation: "put",
              uri: `at://${DID}/${COLLECTION}/candidate`,
              did: DID,
              collection: COLLECTION,
              rkey: "candidate",
              cid: "bafyreig7jv2h5c3xw3dkf5m7zqxf2spwzvug3k4j5qvbcjjr5w6m2wr6li",
              value: { $type: COLLECTION, name: "tail" },
              sourceTimeUs: base + 1_000_000,
              position: {
                source: "test-changes",
                epoch: "one",
                cursor: String(base + 1_000_000),
              },
            },
          ],
          checkpoint: through,
          caughtUp: true,
        };
      },
    };

    await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource: new PdsSnapshotSource(db, resolved, { maxRetries: 0 }),
      changeSource: changes,
      target: new DatabaseBootstrapTarget(db, resolved),
    });

    expect(calls).toEqual(["mark:1", "relay", "pds", "mark:2", "changes"]);
    const records = await queryRecords(db, resolved, { collection: "event" });
    expect(records.records).toHaveLength(1);
    expect(JSON.parse(records.records[0].record).name).toBe("tail");
  });

  it("rejects a PDS record outside its requested repository partition", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(DID, "snapshot.test", "https://pds.allowed.test", Date.now())
      .run();

    fetchSpy.mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "relay.test") {
        return new Response(JSON.stringify({ repos: [{ did: DID }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          records: [
            {
              uri: `at://did:plc:someone-else/${COLLECTION}/wrong`,
              cid: "cid-wrong",
              value: { $type: COLLECTION, name: "wrong" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const source = new PdsSnapshotSource(db, resolved, { maxRetries: 0 });
    const prepared = await source.prepare({ collections: [COLLECTION] });
    const read = async () => {
      for await (const _batch of source.read({ snapshot: prepared })) {
        // Drain the source.
      }
    };
    await expect(read()).rejects.toBeInstanceOf(PdsSnapshotIncompleteError);
  });
});
