/**
 * `<ns>.community.delete` end-to-end against real Postgres.
 *
 * The router endpoint (community/router.ts) and the adapter's
 * `softDeleteCommunity` (community/adapter.ts) have no unit-test coverage
 * for delete today. Beyond filling that gap, what these tests prove that
 * unit tests *can't*:
 *
 *   - Real Postgres writes the `deleted_at` timestamp on both the
 *     `communities` row AND every space owned by the community ($admin
 *     plus any child spaces). Verified by direct SQL on the pool, since
 *     that is the ground-truth representation the rest of the system
 *     reads from.
 *   - `<ns>.community.list` filtering is enforced by SQL
 *     (`listCommunitiesOwningSpaces` joins on `c.deleted_at IS NULL AND
 *     s.deleted_at IS NULL`), not in-memory bookkeeping.
 *   - Subsequent ops on a deleted community fail at the adapter layer:
 *     `getCommunity` returns null because of the `deleted_at IS NULL`
 *     filter, so `<ns>.community.space.create` returns 404.
 *   - Real service-auth JWT verifying through the PDS+PLC chain on the
 *     `owner-required` enforcement path.
 *
 * Prereqs: `pnpm stack:up`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { Client } from "@atcute/client";
import "@atcute/atproto";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config as baseConfig } from "../config";
import {
  createTestAccount,
  createIsolatedSchema,
  createDevnetResolver,
  setupCommunityContrail,
  createCaller,
  login,
  jsonOr,
  CONTRAIL_SERVICE_DID,
  type CallAs,
  type TestAccount,
} from "./helpers";

const NS = `${baseConfig.namespace}.community`;
const SPACE_TYPE = "rsvp.atmo.event.space";
const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

describe("community.delete e2e (soft-delete + cascade, real DB)", () => {
  let alice: TestAccount;   // owner / creator
  let bob: TestAccount;     // promoted to admin in $admin (still NOT owner)

  let aliceClient: Client;
  let bobClient: Client;

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let callAs: CallAs;

  beforeAll(async () => {
    [alice, bob] = await Promise.all([createTestAccount(), createTestAccount()]);
    [aliceClient, bobClient] = await Promise.all([login(alice), login(bob)]);

    const iso = await createIsolatedSchema("test_community_delete");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);

    const contrail = await setupCommunityContrail({
      db,
      baseConfig,
      spaceType: SPACE_TYPE,
      community: {
        serviceDid: CONTRAIL_SERVICE_DID,
        masterKey: TEST_MASTER_KEY,
        resolver: createDevnetResolver(),
      },
    });
    await contrail.init();
    callAs = createCaller(createHandler(contrail));
  });

  afterAll(async () => {
    await cleanupSchema?.();
  });

  // Each test mints its own community so the soft-delete in one doesn't
  // interfere with the next.
  async function mintCommunity(): Promise<string> {
    const res = await callAs(aliceClient, "POST", `${NS}.mint`, { body: {} });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { communityDid: string }).communityDid;
  }

  async function createChildSpace(communityDid: string, key: string): Promise<string> {
    const res = await callAs(aliceClient, "POST", `${NS}.space.create`, {
      body: { communityDid, key },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { space: { uri: string } }).space.uri;
  }

  // ----- happy path: owner deletes, both rows + spaces flip deleted_at ------

  it("owner can soft-delete; communities + all owned spaces get deleted_at set", async () => {
    const communityDid = await mintCommunity();
    const channelUri = await createChildSpace(communityDid, "general");
    const adminUri = `ats://${communityDid}/${SPACE_TYPE}/$admin`;

    // Sanity: pre-delete, deleted_at is NULL on both tables.
    const preCommunity = await pool.query(
      `SELECT deleted_at FROM communities WHERE did = $1`,
      [communityDid],
    );
    expect(preCommunity.rows[0]?.deleted_at).toBeNull();
    // Bootstrap creates one or more reserved spaces ($admin, $publishers, …)
    // in addition to the explicit child space. Don't pin the full set —
    // assert the two we care about are present and live, and that every row
    // is non-deleted.
    const preSpaces = await pool.query(
      `SELECT uri, deleted_at FROM spaces WHERE owner_did = $1`,
      [communityDid],
    );
    const preUris = preSpaces.rows.map((r: { uri: string }) => r.uri);
    expect(preUris).toContain(adminUri);
    expect(preUris).toContain(channelUri);
    for (const row of preSpaces.rows) expect(row.deleted_at).toBeNull();

    // Delete.
    const del = await callAs(aliceClient, "POST", `${NS}.delete`, {
      body: { communityDid },
    });
    expect(del.status, await del.clone().text()).toBe(200);
    expect((await del.json()) as { ok: boolean }).toEqual({ ok: true });

    // (1) Community row's deleted_at is now set.
    const postCommunity = await pool.query(
      `SELECT deleted_at FROM communities WHERE did = $1`,
      [communityDid],
    );
    expect(postCommunity.rows[0]?.deleted_at).not.toBeNull();

    // (2) Every space owned by the community has deleted_at set — the
    // reserved spaces ($admin etc.) and the child "general" space.
    const postSpaces = await pool.query(
      `SELECT uri, deleted_at FROM spaces WHERE owner_did = $1`,
      [communityDid],
    );
    // Same query, same connection — count must match exactly. A regression
    // that orphans rows or creates new ones during delete would fail here.
    expect(postSpaces.rows.length).toBe(preSpaces.rows.length);
    for (const row of postSpaces.rows) expect(row.deleted_at).not.toBeNull();
  });

  // ----- list filtering is real ---------------------------------------------

  it("post-delete community is excluded from <ns>.community.list (DB-filtered)", async () => {
    const communityDid = await mintCommunity();

    // Pre-delete: owner sees the community.
    const before = await callAs(aliceClient, "GET", `${NS}.list`);
    const beforeDids = ((await jsonOr(before)) as {
      communities: Array<{ did: string }>;
    }).communities.map((c) => c.did);
    expect(beforeDids).toContain(communityDid);

    // Delete.
    const del = await callAs(aliceClient, "POST", `${NS}.delete`, {
      body: { communityDid },
    });
    expect(del.status).toBe(200);

    // Post-delete: the same listing call no longer returns it. The filter
    // lives in `listCommunitiesOwningSpaces` (real SQL), so this round-trip
    // proves the join condition fires end-to-end, not just in unit-test
    // mocks.
    const after = await callAs(aliceClient, "GET", `${NS}.list`);
    const afterDids = ((await jsonOr(after)) as {
      communities: Array<{ did: string }>;
    }).communities.map((c) => c.did);
    expect(afterDids).not.toContain(communityDid);
  });

  // ----- subsequent ops fail at the adapter layer ---------------------------

  it("post-delete: community.space.create returns 404 (getCommunity filters deleted)", async () => {
    const communityDid = await mintCommunity();

    const del = await callAs(aliceClient, "POST", `${NS}.delete`, {
      body: { communityDid },
    });
    expect(del.status).toBe(200);

    // `community.space.create` calls `getCommunity` which filters
    // `deleted_at IS NULL`, so a deleted community looks like a missing
    // community to subsequent endpoints — no special "tombstone" path.
    const create = await callAs(aliceClient, "POST", `${NS}.space.create`, {
      body: { communityDid, key: "afterlife" },
    });
    expect(create.status).toBe(404);
    const data = (await jsonOr(create)) as { error: string; reason?: string };
    expect(data.error).toBe("NotFound");
    expect(data.reason).toBe("community-not-found");
  });

  // ----- owner-required enforcement -----------------------------------------
  // The endpoint requires `owner` specifically (not admin+). An admin in
  // $admin should be rejected with `owner-required`.

  it("admin (not owner) cannot delete the community", async () => {
    const communityDid = await mintCommunity();
    const adminUri = `ats://${communityDid}/${SPACE_TYPE}/$admin`;

    // Promote bob to admin in $admin — strictly below owner.
    const grant = await callAs(aliceClient, "POST", `${NS}.space.grant`, {
      body: {
        spaceUri: adminUri,
        subject: { did: bob.did },
        accessLevel: "admin",
      },
    });
    expect(grant.status, await grant.clone().text()).toBe(200);

    const del = await callAs(bobClient, "POST", `${NS}.delete`, {
      body: { communityDid },
    });
    expect(del.status).toBe(403);
    const data = (await jsonOr(del)) as { error: string; reason: string };
    expect(data.error).toBe("Forbidden");
    expect(data.reason).toBe("owner-required");

    // And the community is still alive — deleted_at is still NULL.
    const row = await pool.query(
      `SELECT deleted_at FROM communities WHERE did = $1`,
      [communityDid],
    );
    expect(row.rows[0]?.deleted_at).toBeNull();
  });

  // ----- stranger gets the same 403 (not 404) --------------------------------
  // A user with no role on the community still hits the level check — the
  // endpoint shape is "Forbidden / owner-required", not "NotFound", which
  // matters because it tells the caller the resource exists but they're
  // not the owner. Distinct from the post-delete "community-not-found" case
  // above.

  it("non-member cannot delete the community", async () => {
    const communityDid = await mintCommunity();

    const stranger = await createTestAccount();
    const strangerClient = await login(stranger);
    const del = await callAs(strangerClient, "POST", `${NS}.delete`, {
      body: { communityDid },
    });
    expect(del.status).toBe(403);
    const data = (await jsonOr(del)) as { error: string; reason: string };
    expect(data.error).toBe("Forbidden");
    expect(data.reason).toBe("owner-required");
  });
});
