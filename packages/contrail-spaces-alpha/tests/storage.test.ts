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
  invalidateRevokedCredential,
  listConnectedSpaceWatches,
  loadCredential,
  rediscoverSpace,
  renewSyncLease,
  saveAccessLease,
  saveCredential,
  updateWatch,
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
        format: "http-signature-v1",
        token: "private-token",
        privateKey: "private",
        expiresAt: Date.now() + 60_000,
      },
    });
    await saveAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
      expiresAt: Date.now() + 60_000,
    });
    expect(
      (
        await loadCredential(db, {
          spaceUri: space,
          generation: watch.generation,
          encryptionKey: key,
        })
      )?.credential.token,
    ).toBe("private-token");
    expect(
      await hasAccessLease(db, {
        userDid: "did:plc:alice",
        spaceUri: space,
        generation: watch.generation,
      }),
    ).toBe(true);
    expect(
      await hasAccessLease(db, {
        userDid: "did:plc:alice",
        spaceUri: space,
        generation: watch.generation + 1,
      }),
    ).toBe(false);

    await hideDeletedSpace(db, watch);
    expect((await getSpaceWatch(db, space))?.status).toBe("hidden");
    expect(
      await loadCredential(db, {
        spaceUri: space,
        generation: watch.generation,
        encryptionKey: key,
      }),
    ).toBeNull();
    expect(
      await hasAccessLease(db, {
        userDid: "did:plc:alice",
        spaceUri: space,
        generation: watch.generation,
      }),
    ).toBe(false);
  });

  it.each([false, true])(
    "invalidates only the failed credential (concurrent replacement=%s)",
    async (replace) => {
      const db = createSqliteDatabase(":memory:");
      await initSpacesStorage(db, projection);
      await ensureSpaceWatch(db, { spaceUri: space });
      const encryptionKey = await generateCredentialEncryptionKey();
      const input = {
        spaceUri: space,
        generation: 1,
        viewerDid: "did:plc:bob",
        encryptionKey,
        credential: {
          format: "http-signature-v1" as const,
          token: "old",
          privateKey: "private",
          expiresAt: Date.now() + 60_000,
        },
      };
      await saveCredential(db, input);
      await saveAccessLease(db, {
        userDid: input.viewerDid,
        spaceUri: space,
        generation: 1,
        expiresAt: Date.now() + 60_000,
      });
      const old = (await loadCredential(db, input))!;
      const lease = {
        spaceUri: space,
        generation: 1,
        repoDid: "did:plc:bob",
        owner: "in-flight",
      };
      expect(await acquireSyncLease(db, lease)).toBe(true);
      if (replace) {
        await saveCredential(db, {
          ...input,
          credential: { ...input.credential, token: "replacement" },
        });
      }
      // A delayed failure must not invalidate a fresh credential or read grant.
      await invalidateRevokedCredential(db, {
        spaceUri: space,
        generation: 1,
        encryptedValue: old.encryptedValue,
      });
      const retained = await loadCredential(db, input);
      expect(retained?.credential.token ?? null).toBe(
        replace ? "replacement" : null,
      );
      expect((await getSpaceWatch(db, space))?.status).toBe(
        replace ? "active" : "paused",
      );
      expect(
        await hasAccessLease(db, {
          userDid: input.viewerDid,
          spaceUri: space,
          generation: 1,
        }),
      ).toBe(replace);
      // Reauthorization must not let work using the revoked credential regain
      // its old sync fence. A concurrently replaced credential is unaffected.
      await updateWatch(db, space, { status: "active" });
      expect(await renewSyncLease(db, lease)).toBe(replace);
    },
  );

  it("does not let an in-flight reconciliation reactivate a paused watch", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: space });
    await updateWatch(db, space, { status: "paused" });
    await updateWatch(db, space, {
      status: "active",
      expectedGeneration: 1,
      expectedStatus: "active",
    });
    expect((await getSpaceWatch(db, space))?.status).toBe("paused");
  });

  it("lists only owned or currently authorized provider connections", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    const watch = await ensureSpaceWatch(db, { spaceUri: space });
    expect(
      await listConnectedSpaceWatches(db, {
        userDid: "did:plc:bob",
        limit: 10,
      }),
    ).toEqual([]);
    await saveAccessLease(db, {
      userDid: "did:plc:bob",
      spaceUri: space,
      generation: watch.generation,
      expiresAt: Date.now() + 60_000,
    });
    expect(
      (
        await listConnectedSpaceWatches(db, {
          userDid: "did:plc:bob",
          limit: 10,
        })
      ).map((item) => item.spaceUri),
    ).toEqual([space]);
    expect(
      (
        await listConnectedSpaceWatches(db, {
          userDid: "did:plc:alice",
          limit: 10,
        })
      ).map((item) => item.spaceUri),
    ).toEqual([space]);
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

    await db
      .prepare(
        `UPDATE spaces_sync_leases SET expires_at = 0
       WHERE space_uri = ? AND space_generation = ? AND repo_did = ?`,
      )
      .bind(space, 1, "did:plc:bob")
      .run();
    expect(await renewSyncLease(db, { ...lease, owner: "one" })).toBe(false);
    expect(await acquireSyncLease(db, { ...lease, owner: "two" })).toBe(true);
    expect(await renewSyncLease(db, { ...lease, owner: "one" })).toBe(false);
  });

  it("rediscovery is hidden-only and stale deletion cannot clear the new generation", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    const oldWatch = await ensureSpaceWatch(db, { spaceUri: space });
    await expect(rediscoverSpace(db, space)).rejects.toThrow(
      /previously deleted/,
    );

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
        format: "http-signature-v1",
        token: "new-generation-token",
        privateKey: "private",
        expiresAt: Date.now() + 60_000,
      },
    });
    await saveAccessLease(db, {
      userDid: "did:plc:alice",
      spaceUri: space,
      generation: watch.generation,
      expiresAt: Date.now() + 60_000,
    });
    expect(
      await acquireSyncLease(db, {
        spaceUri: space,
        generation: watch.generation,
        repoDid: "did:plc:bob",
        owner: "new-generation",
        ttlMs: 60_000,
      }),
    ).toBe(true);

    // Simulate delayed deletion work retaining the pre-rediscovery watch.
    await hideDeletedSpace(db, oldWatch);
    expect(await getSpaceWatch(db, space)).toMatchObject({
      status: "active",
      generation: watch.generation,
    });
    expect(
      (
        await loadCredential(db, {
          spaceUri: space,
          generation: watch.generation,
          encryptionKey: key,
        })
      )?.credential.token,
    ).toBe("new-generation-token");
    expect(
      await hasAccessLease(db, {
        userDid: "did:plc:alice",
        spaceUri: space,
        generation: watch.generation,
      }),
    ).toBe(true);
    expect(
      await acquireSyncLease(db, {
        spaceUri: space,
        generation: watch.generation,
        repoDid: "did:plc:bob",
        owner: "stale-contender",
        ttlMs: 60_000,
      }),
    ).toBe(false);
  });
});
