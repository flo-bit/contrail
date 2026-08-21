import { describe, expect, it } from "vitest";
import {
  createIngestEvent,
  createIsolatedProjection,
  hideIsolatedPartitionStatement,
  ingestRecords,
  initIsolatedProjection,
  initSchema,
  queryIsolatedRecords,
  queryRecords,
  rebuildIsolatedCountsStatements,
  resolveConfig,
} from "../src/index";
import { createTestDb } from "./helpers";

const config = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: {
      collection: "garden.atmo.circle.note",
      searchable: ["text"],
      queryable: { createdAt: { type: "range" } },
      relations: {
        reactions: { collection: "reaction", field: "subject.uri" },
      },
    },
    reaction: {
      collection: "garden.atmo.circle.reaction",
      references: {
        note: { collection: "note", field: "subject.uri" },
      },
    },
  },
});

const scope = (space: string, generation = 1) => ({
  kind: "isolated" as const,
  key: `${space}\u0000${generation}`,
});

function event(input: {
  space: string;
  did?: string;
  collection?: "note" | "reaction";
  rkey?: string;
  value?: Record<string, unknown>;
  operation?: "create" | "update" | "delete";
  revision?: string;
}) {
  const did = input.did ?? "did:plc:alice";
  const short = input.collection ?? "note";
  const collection = `garden.atmo.circle.${short}`;
  const rkey = input.rkey ?? "one";
  return createIngestEvent({
    uri: `${input.space}/${did}/${collection}/${rkey}`,
    did,
    collection,
    rkey,
    operation: input.operation ?? "create",
    cid: input.operation === "delete" ? null : `bafy-${input.revision ?? "1"}`,
    value: input.value ?? { text: "private hello", createdAt: "2026-08-21T00:00:00Z" },
    timeUs: 1_000_000,
    source: {
      id: `space:${input.space}`,
      revision: input.revision ?? "1",
      time_us: 1_000_000,
    },
  });
}

async function project(
  db: ReturnType<typeof createTestDb>,
  target: Parameters<typeof createIsolatedProjection>[0],
  events: ReturnType<typeof event>[],
  authoritativeSourceObservation = false,
) {
  return ingestRecords(db, events, config, {
    projection: createIsolatedProjection(target),
    authoritativeSourceObservation,
    skipDiagnostics: true,
  });
}

describe("isolated projection", () => {
  it("keeps public and colliding Space rows physically isolated", async () => {
    const db = createTestDb();
    await initSchema(db, config);
    await initIsolatedProjection(db, config);
    const alice = "at://did:plc:alice/space/garden.atmo.circle/self";
    const carol = "at://did:plc:carol/space/garden.atmo.circle/self";

    await project(db, {
      scope: scope(alice), partition: "did:plc:alice", generation: 1, activate: true,
    }, [event({ space: alice })]);
    await project(db, {
      scope: scope(carol), partition: "did:plc:alice", generation: 1, activate: true,
    }, [event({ space: carol, value: { text: "other secret" } })]);

    const aliceRows = await queryIsolatedRecords(db, config, {
      scope: scope(alice), collection: "note",
    });
    const carolRows = await queryIsolatedRecords(db, config, {
      scope: scope(carol), collection: "note",
    });
    expect(aliceRows.records).toHaveLength(1);
    expect(JSON.parse(aliceRows.records[0].record!)).toMatchObject({ text: "private hello" });
    expect(JSON.parse(carolRows.records[0].record!)).toMatchObject({ text: "other secret" });
    expect((await queryRecords(db, config, { collection: "note" })).records).toEqual([]);
  });

  it("searches, resolves references, and counts only visible writers in one Space", async () => {
    const db = createTestDb();
    await initIsolatedProjection(db, config);
    const space = "at://did:plc:alice/space/garden.atmo.circle/self";
    const note = event({ space });
    await project(db, {
      scope: scope(space), partition: "did:plc:alice", generation: 1, activate: true,
    }, [note]);
    await project(db, {
      scope: scope(space), partition: "did:plc:bob", generation: 1, activate: true,
    }, [event({
      space,
      did: "did:plc:bob",
      collection: "reaction",
      value: { subject: { uri: note.uri, cid: note.cid }, createdAt: "2026-08-21T00:00:01Z" },
    })]);

    const notes = await queryIsolatedRecords(db, config, {
      scope: scope(space), collection: "note", search: "hello",
    });
    expect(notes.records[0].counts).toEqual({ reaction: 1 });

    const reactions = await queryIsolatedRecords(db, config, {
      scope: scope(space), collection: "reaction",
    });
    expect(reactions.references?.[note.uri]?.uri).toBe(note.uri);

    await db.batch([
      hideIsolatedPartitionStatement(db, scope(space), "did:plc:bob"),
      ...rebuildIsolatedCountsStatements(db, config, scope(space)),
    ]);
    const afterRemoval = await queryIsolatedRecords(db, config, {
      scope: scope(space), collection: "note",
    });
    expect(afterRemoval.records[0].counts).toBeUndefined();
  });

  it("additively migrates relation-count columns on an existing schema", async () => {
    const db = createTestDb();
    const initial = resolveConfig({
      namespace: "garden.atmo.circle",
      profiles: [],
      collections: {
        note: { collection: "garden.atmo.circle.note" },
        reaction: { collection: "garden.atmo.circle.reaction" },
      },
    });
    await initIsolatedProjection(db, initial);
    await initIsolatedProjection(db, config);

    const space = "at://did:plc:alice/space/garden.atmo.circle/self";
    const note = event({ space });
    await project(db, {
      scope: scope(space), partition: "did:plc:alice", generation: 1, activate: true,
    }, [note]);
    await project(db, {
      scope: scope(space), partition: "did:plc:bob", generation: 1, activate: true,
    }, [event({
      space,
      did: "did:plc:bob",
      collection: "reaction",
      value: { subject: { uri: note.uri }, createdAt: "2026-08-21T00:00:01Z" },
    })]);

    const result = await queryIsolatedRecords(db, config, {
      scope: scope(space), collection: "note",
    });
    expect(result.records[0].counts).toEqual({ reaction: 1 });
  });

  it("atomically switches a recovered writer generation", async () => {
    const db = createTestDb();
    await initIsolatedProjection(db, config);
    const space = "at://did:plc:alice/space/garden.atmo.circle/self";
    await project(db, {
      scope: scope(space), partition: "did:plc:alice", generation: 1, activate: true,
    }, [event({ space, revision: "1", value: { text: "old" } })]);
    await project(db, {
      scope: scope(space), partition: "did:plc:alice", generation: 2, activate: true,
    }, [event({ space, revision: "2", value: { text: "recovered" } })], true);

    const result = await queryIsolatedRecords(db, config, {
      scope: scope(space), collection: "note",
    });
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(result.records[0].record!)).toMatchObject({ text: "recovered" });
  });
});
