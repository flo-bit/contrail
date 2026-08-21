import {
  createIngestEvent,
  createIsolatedProjection,
  ingestRecords,
  resolveConfig,
} from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { describe, expect, it } from "vitest";
import {
  hasProjectedSpaceAccess,
  initSpacesStorage,
  ensureSpaceWatch,
} from "../src/storage";
import {
  authorityRecordMembership,
  initializeSpaceAccessPolicies,
} from "../src/sync";
import { spaceProjectionKey } from "../src/uri";

const space = "at://did:plc:alice/space/garden.atmo.circle/self";
const memberCollection = "garden.atmo.circle.member";
const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    member: {
      collection: memberCollection,
      queryable: { subject: {} },
    },
  },
});

function memberEvent(writer: string, rkey: string, subject: string) {
  return createIngestEvent({
    uri: `${space}/${writer}/${memberCollection}/${rkey}`,
    did: writer,
    collection: memberCollection,
    rkey,
    operation: "create",
    cid: `bafy-${rkey}`,
    value: {
      $type: memberCollection,
      subject,
      createdAt: "2026-08-21T00:00:00Z",
    },
    timeUs: 1_000_000,
    source: { id: "access-test", revision: "1", time_us: 1_000_000 },
  });
}

describe("materialized Space access policy", () => {
  it("backfills only authority-authored membership from the visible projection", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    const watch = await ensureSpaceWatch(db, { spaceUri: space });
    const scope = {
      kind: "isolated" as const,
      key: spaceProjectionKey(space, watch.generation),
    };
    await ingestRecords(db, [
      memberEvent("did:plc:alice", "owner-member", "did:plc:carol"),
    ], projection, {
      projection: createIsolatedProjection({
        scope,
        partition: "did:plc:alice",
        generation: 1,
        activate: true,
      }),
      skipDiagnostics: true,
    });
    await ingestRecords(db, [
      memberEvent("did:plc:bob", "forged-member", "did:plc:dave"),
    ], projection, {
      projection: createIsolatedProjection({
        scope,
        partition: "did:plc:bob",
        generation: 1,
        activate: true,
      }),
      skipDiagnostics: true,
    });

    await initializeSpaceAccessPolicies(db, {
      projection,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [memberCollection],
          access: authorityRecordMembership({
            collection: memberCollection,
            principalField: "subject",
          }),
        },
      },
    });

    expect(await hasProjectedSpaceAccess(db, {
      spaceUri: space,
      spaceGeneration: 1,
      principalDid: "did:plc:carol",
    })).toBe(true);
    expect(await hasProjectedSpaceAccess(db, {
      spaceUri: space,
      spaceGeneration: 1,
      principalDid: "did:plc:dave",
    })).toBe(false);
  });
});
