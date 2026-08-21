import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { resolveConfig } from "@atmo-dev/contrail";
import { describe, expect, it } from "vitest";
import { generateCredentialEncryptionKey } from "../src/crypto";
import {
  acquireSyncLease,
  ensureSpaceWatch,
  getSpaceWatch,
  hasAccessLease,
  hideDeletedSpace,
  initSpacesStorage,
  loadCredential,
  rediscoverSpace,
  renewSyncLease,
  saveAccessLease,
  saveCredential,
} from "../src/storage";

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: { collection: "garden.atmo.circle.note" },
  },
});

const space = "at://did:plc:alice/space/garden.atmo.circle/self";

describe("Spaces storage boundaries", () => {
  it("binds encrypted credentials and access leases to the Space generation", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    const watch = await ensureSpaceWatch(db, { spaceUri: space });
    const key = await generateCredentialEncryptionKey();
    await saveCredential(db, {
      spaceUri: space,
      generation: watch.generation,
      viewerDid: "did:plc:alice",
      encryptionKey: key,
      credential: {
        token: "private-token",
        privateJwk: { kty: "EC", d: "private" },
        expiresAt: Date.now() + 60_000,
      },
    });
    await saveAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
      expiresAt: Date.now() + 60_000,
    });
    expect((await loadCredential(db, {
      spaceUri: space,
      generation: watch.generation,
      encryptionKey: key,
    }))?.credential.token).toBe("private-token");
    expect(await hasAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
    })).toBe(true);
    expect(await hasAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation + 1,
    })).toBe(false);

    await hideDeletedSpace(db, watch);
    expect((await getSpaceWatch(db, space))?.status).toBe("hidden");
    expect(await loadCredential(db, {
      spaceUri: space,
      generation: watch.generation,
      encryptionKey: key,
    })).toBeNull();
    expect(await hasAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
    })).toBe(false);
  });

  it("allows only one unexpired sync-lease owner and fences stale owners", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    const lease = {
      spaceUri: space,
      generation: 1,
      repoDid: "did:plc:bob",
      ttlMs: 60_000,
    };
    expect(await acquireSyncLease(db, { ...lease, owner: "one" })).toBe(true);
    expect(await acquireSyncLease(db, { ...lease, owner: "two" })).toBe(false);
    expect(await renewSyncLease(db, { ...lease, owner: "one" })).toBe(true);

    await db.prepare(
      `UPDATE spaces_sync_leases SET expires_at = 0
       WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
    ).bind(space, 1, "did:plc:bob").run();
    expect(await renewSyncLease(db, { ...lease, owner: "one" })).toBe(false);
    expect(await acquireSyncLease(db, { ...lease, owner: "two" })).toBe(true);
    expect(await renewSyncLease(db, { ...lease, owner: "one" })).toBe(false);
  });

  it("rediscovery is hidden-only and stale deletion cannot clear the new generation", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    const oldWatch = await ensureSpaceWatch(db, { spaceUri: space });
    await expect(rediscoverSpace(db, space)).rejects.toThrow(/previously deleted/);

    await hideDeletedSpace(db, oldWatch);
    const watch = await rediscoverSpace(db, space);
    expect(watch.generation).toBe(oldWatch.generation + 1);
    const key = await generateCredentialEncryptionKey();
    await saveCredential(db, {
      spaceUri: space,
      generation: watch.generation,
      viewerDid: "did:plc:alice",
      encryptionKey: key,
      credential: {
        token: "new-generation-token",
        privateJwk: { kty: "EC", d: "private" },
        expiresAt: Date.now() + 60_000,
      },
    });
    await saveAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
      expiresAt: Date.now() + 60_000,
    });
    expect(await acquireSyncLease(db, {
      spaceUri: space,
      generation: watch.generation,
      repoDid: "did:plc:bob",
      owner: "new-generation",
      ttlMs: 60_000,
    })).toBe(true);

    // Simulate delayed deletion work retaining the pre-rediscovery watch.
    await hideDeletedSpace(db, oldWatch);
    expect(await getSpaceWatch(db, space)).toMatchObject({
      status: "active",
      generation: watch.generation,
    });
    expect((await loadCredential(db, {
      spaceUri: space,
      generation: watch.generation,
      encryptionKey: key,
    }))?.credential.token).toBe("new-generation-token");
    expect(await hasAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
    })).toBe(true);
    expect(await acquireSyncLease(db, {
      spaceUri: space,
      generation: watch.generation,
      repoDid: "did:plc:bob",
      owner: "stale-contender",
      ttlMs: 60_000,
    })).toBe(false);
  });
});
