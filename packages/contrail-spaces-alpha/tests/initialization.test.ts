import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { resolveConfig } from "@atmo-dev/contrail";
import {
  acquireSyncLease,
  ensureSpaceWatch,
  getSpaceWatch,
  hasAccessLease,
  initSpacesStorage,
  releaseSyncLease,
  saveAccessLease,
  saveCredential,
  loadCredential,
  saveRepoStateStatement,
  getRepoState,
  syncLeaseFenceStatements,
} from "../src/storage";

const space = "at://did:plc:alice/space/garden.example.circle/self";
const config = resolveConfig({
  namespace: "garden.example.circle",
  collections: { note: { collection: "garden.example.note" } },
});

describe("Spaces storage initialization and fencing", () => {
  it("initializes idempotently without resetting active connections or verified checkpoints", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, config);
    const watch = await ensureSpaceWatch(db, { spaceUri: space });
    expect(watch.registrationPdsUrl).toBeNull();
    const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const input = {
      spaceUri: space,
      generation: watch.generation,
      userDid: "did:plc:bob",
    };
    await saveAccessLease(db, { ...input, expiresAt: Date.now() + 60_000 });
    const credential = {
      format: "http-signature-v1" as const,
      token: "credential",
      privateKey: "private",
      expiresAt: Date.now() + 60_000,
    };
    await saveCredential(db, {
      ...input,
      viewerDid: input.userDid,
      encryptionKey,
      credential,
    });
    const state = {
      spaceUri: space,
      spaceGeneration: watch.generation,
      repoDid: input.userDid,
      pdsUrl: "https://writer.test",
      visibleWriterGeneration: 1,
      rev: "1",
      ltHash: new Uint8Array(2048),
      commitHash: new Uint8Array(32),
      removalObservations: 0,
    };
    await saveRepoStateStatement(db, state).run();
    await initSpacesStorage(db, config);
    await initSpacesStorage(db, config);
    expect(await getSpaceWatch(db, space)).toEqual(watch);
    expect(await hasAccessLease(db, input)).toBe(true);
    expect(
      (await loadCredential(db, { ...input, encryptionKey }))?.credential,
    ).toEqual(credential);
    expect(await getRepoState(db, watch, input.userDid)).toEqual(state);
  });

  it("rolls back stale-worker writes in the projection transaction", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, config);
    const watch = await ensureSpaceWatch(db, { spaceUri: space });
    const lease = {
      spaceUri: space,
      generation: watch.generation,
      repoDid: "did:plc:alice",
      owner: "current",
    };
    await acquireSyncLease(db, lease);
    const mutation = () =>
      db
        .prepare(
          "UPDATE spaces_watches SET last_error = 'committed' WHERE space_uri = ?",
        )
        .bind(space);
    await expect(
      db.batch([
        mutation(),
        ...syncLeaseFenceStatements(db, { ...lease, owner: "stale" }),
      ]),
    ).rejects.toThrow();
    expect((await getSpaceWatch(db, space))?.lastError).toBeNull();
    await db.batch([mutation(), ...syncLeaseFenceStatements(db, lease)]);
    expect((await getSpaceWatch(db, space))?.lastError).toBe("committed");
    await releaseSyncLease(db, lease);
    await expect(
      db.batch(syncLeaseFenceStatements(db, lease)),
    ).rejects.toThrow();
  });
});
