/**
 * Invite end-to-end against a real PDS, real PLC, real Postgres.
 *
 * Unit tests in `packages/contrail/tests/invite-unified.test.ts` cover the
 * router-level dispatch and validation (kind/accessLevel exclusivity, 403s,
 * cannot-grant-higher-than-self). What unit tests can't show is:
 *
 *   - Real service-auth JWT verifying through the PDS+PLC chain
 *     (unit tests use a fakeAuth middleware).
 *   - The reconcile cascade — community.grant fired by invite.redeem must
 *     update both the community ACL AND spaces.access_rows. Verified here
 *     by hitting `community.space.listMembers?flatten=true`, which reads
 *     from spaces.access_rows directly.
 *   - Real Postgres enforcement of single-use / revoked invites (the redeem
 *     query is the source of truth, not in-memory state).
 *
 * Both invite paths are exercised:
 *
 *   - Community-owned space: alice (admin in $admin) creates a child space,
 *     mints accessLevel=member invite, bob redeems → grant + reconcile.
 *   - User-owned space: alice creates her own space, mints kind=join invite,
 *     bob redeems → addMember. No community module involvement.
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

const NS = baseConfig.namespace;
const SPACE_TYPE = "rsvp.atmo.event.space";
const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

describe("invite e2e (community + user-owned, real JWT)", () => {
  let alice: TestAccount;
  let bob: TestAccount;
  let charlie: TestAccount;

  let aliceClient: Client;
  let bobClient: Client;
  let charlieClient: Client;

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let callAs: CallAs;

  let communityDid: string;
  let channelUri: string;

  beforeAll(async () => {
    [alice, bob, charlie] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);
    [aliceClient, bobClient, charlieClient] = await Promise.all([
      login(alice),
      login(bob),
      login(charlie),
    ]);

    const iso = await createIsolatedSchema("test_community_invites");
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

    // Mint a community owned by alice; alice becomes owner of $admin via
    // bootstrap and can then create child spaces.
    const mint = await callAs(aliceClient, "POST", `${NS}.community.mint`, { body: {} });
    expect(mint.status, await mint.clone().text()).toBe(200);
    communityDid = ((await mint.json()) as { communityDid: string }).communityDid;

    // Create a child space for invite tests; alice becomes its owner.
    const create = await callAs(aliceClient, "POST", `${NS}.community.space.create`, {
      body: { communityDid, key: "general" },
    });
    expect(create.status, await create.clone().text()).toBe(200);
    channelUri = ((await create.json()) as { space: { uri: string } }).space.uri;
  });

  afterAll(async () => {
    await cleanupSchema?.();
  });

  // ----- community happy path: grant + reconcile cascade --------------------

  it("redeem grants in community ACL AND reconciles to spaces.access_rows", async () => {
    const create = await callAs(aliceClient, "POST", `${NS}.invite.create`, {
      body: { spaceUri: channelUri, accessLevel: "member" },
    });
    expect(create.status, await create.clone().text()).toBe(200);
    const { token, invite } = (await create.json()) as {
      token: string;
      invite: { tokenHash: string; accessLevel: string };
    };
    expect(invite.accessLevel).toBe("member");

    const redeem = await callAs(bobClient, "POST", `${NS}.invite.redeem`, {
      body: { token },
    });
    expect(redeem.status, await redeem.clone().text()).toBe(200);
    const redeemed = (await redeem.json()) as {
      spaceUri: string;
      accessLevel: string;
      communityDid: string;
    };
    expect(redeemed.spaceUri).toBe(channelUri);
    expect(redeemed.accessLevel).toBe("member");
    expect(redeemed.communityDid).toBe(communityDid);

    // (1) Community ACL has bob at member.
    const aclList = await callAs(aliceClient, "GET", `${NS}.community.space.listMembers`, {
      query: { spaceUri: channelUri },
    });
    expect(aclList.status).toBe(200);
    const { rows } = (await jsonOr(aclList)) as {
      rows: Array<{ subject: { did?: string }; accessLevel: string }>;
    };
    const aclBob = rows.find((r) => r.subject.did === bob.did);
    expect(aclBob?.accessLevel).toBe("member");

    // (2) Reconcile cascade: spaces.access_rows now has bob too.
    // `flatten=true` reads from the spaces table, not the community ACL.
    const flatList = await callAs(aliceClient, "GET", `${NS}.community.space.listMembers`, {
      query: { spaceUri: channelUri, flatten: "true" },
    });
    expect(flatList.status).toBe(200);
    const { members } = (await jsonOr(flatList)) as {
      members: Array<{ did: string }>;
    };
    expect(members.map((m) => m.did)).toContain(bob.did);

    // (3) Bob's whoami resolves to the granted level via the same path that
    // app code would use to gate UI/API access.
    const whoami = await callAs(bobClient, "GET", `${NS}.spaceExt.whoami`, {
      query: { spaceUri: channelUri },
    });
    expect(whoami.status).toBe(200);
    const { isMember, accessLevel } = (await jsonOr(whoami)) as {
      isMember: boolean;
      accessLevel: string;
    };
    expect(isMember).toBe(true);
    expect(accessLevel).toBe("member");
  });

  // ----- single-use enforcement at the real-DB layer ------------------------

  it("maxUses=1 invite rejects a second redemption (DB-enforced, not in-memory)", async () => {
    const create = await callAs(aliceClient, "POST", `${NS}.invite.create`, {
      body: { spaceUri: channelUri, accessLevel: "member", maxUses: 1 },
    });
    expect(create.status).toBe(200);
    const { token } = (await create.json()) as { token: string };

    // First redemption succeeds (use a fresh outsider so the prior test's
    // grant doesn't mask the count).
    const dave = await createTestAccount();
    const daveClient = await login(dave);
    const first = await callAs(daveClient, "POST", `${NS}.invite.redeem`, {
      body: { token },
    });
    expect(first.status, await first.clone().text()).toBe(200);

    // Second redemption by a different account is rejected.
    const second = await callAs(charlieClient, "POST", `${NS}.invite.redeem`, {
      body: { token },
    });
    expect(second.status).toBe(400);
    const data = (await jsonOr(second)) as { error: string };
    expect(data.error).toBe("InvalidInvite");
  });

  // ----- revoke roundtrip ---------------------------------------------------

  it("revoked invite cannot be redeemed", async () => {
    const create = await callAs(aliceClient, "POST", `${NS}.invite.create`, {
      body: { spaceUri: channelUri, accessLevel: "member" },
    });
    const { token, invite } = (await create.json()) as {
      token: string;
      invite: { tokenHash: string };
    };

    const revoke = await callAs(aliceClient, "POST", `${NS}.invite.revoke`, {
      body: { spaceUri: channelUri, tokenHash: invite.tokenHash },
    });
    expect(revoke.status, await revoke.clone().text()).toBe(200);

    const redeem = await callAs(charlieClient, "POST", `${NS}.invite.redeem`, {
      body: { token },
    });
    expect(redeem.status).toBe(400);
    const data = (await jsonOr(redeem)) as { error: string };
    expect(data.error).toBe("InvalidInvite");
  });

  // ----- user-owned space: simpler path, no reconcile -----------------------
  // Owner creates a space they personally own; invite confers `kind=join` and
  // redeem calls `addMember` — no community module touched.

  it("user-owned space: kind=join invite roundtrip adds redeemer as a member", async () => {
    const createSpace = await callAs(aliceClient, "POST", `${NS}.space.createSpace`, {
      body: {},
    });
    expect(createSpace.status, await createSpace.clone().text()).toBe(200);
    const userSpaceUri = (
      (await createSpace.json()) as { space: { uri: string; ownerDid: string } }
    ).space.uri;

    const createInvite = await callAs(aliceClient, "POST", `${NS}.invite.create`, {
      body: { spaceUri: userSpaceUri, kind: "join" },
    });
    expect(createInvite.status, await createInvite.clone().text()).toBe(200);
    const { token, invite } = (await createInvite.json()) as {
      token: string;
      invite: { kind: string };
    };
    expect(invite.kind).toBe("join");

    const redeem = await callAs(bobClient, "POST", `${NS}.invite.redeem`, {
      body: { token },
    });
    expect(redeem.status, await redeem.clone().text()).toBe(200);
    const redeemed = (await redeem.json()) as { spaceUri: string; kind: string };
    expect(redeemed.spaceUri).toBe(userSpaceUri);
    expect(redeemed.kind).toBe("join");

    // Owner can listMembers; bob shows up.
    const list = await callAs(aliceClient, "GET", `${NS}.space.listMembers`, {
      query: { spaceUri: userSpaceUri },
    });
    expect(list.status).toBe(200);
    const { members } = (await jsonOr(list)) as {
      members: Array<{ did: string }>;
    };
    expect(members.map((m) => m.did)).toContain(bob.did);
  });
});
