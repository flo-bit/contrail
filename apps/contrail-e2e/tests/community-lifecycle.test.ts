/**
 * Community lifecycle end-to-end: mint → bootstrap reserved spaces → grant →
 * list → setAccessLevel → revoke → ownership handoff.
 *
 * The community module exposes a 4-level access ladder (member → manager →
 * admin → owner) on the reserved `$admin` space; everything else (granting
 * roles, listing members, transferring ownership) is operations on that
 * ACL. Ownership handoff is therefore role rotation: promote a successor
 * to `owner`, then demote or revoke the departing owner. The community
 * DID itself never moves.
 *
 * Last-owner guard: revoking or demoting the only `owner` on a space is
 * refused with 409 / `reason: "last-owner"`. On `$admin` this prevents the
 * "alice locks herself out of her own community" footgun; on any other
 * space it preserves the only role that can grant `owner`. Hand off
 * ownership first by promoting a successor.
 *
 * Each test mints its own service-auth JWT per call — same pattern as
 * spaces-auth.test.ts. No mocks on the auth path; real PDS → real PLC →
 * real verifier.
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

// Deterministic 32-byte key for envelope-encrypting community credentials in
// tests. Production uses a KMS-sourced secret — this is fine for devnet-only.
const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

describe("community lifecycle (mint → grant → list → revoke, + gap probes)", () => {
  let alice: TestAccount;   // creator / owner
  let bob: TestAccount;     // promoted to manager → admin
  let carol: TestAccount;   // member

  let aliceClient: Client;
  let bobClient: Client;

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let callAs: CallAs;

  let communityDid: string;
  let adminSpaceUri: string;

  beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    aliceClient = await login(alice);
    bobClient = await login(bob);

    const iso = await createIsolatedSchema("test_community_lifecycle");
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

  // ----- create a community with a 4-level ACL -----------------------------

  it("mints a community and returns a recovery key to the creator", async () => {
    const res = await callAs(aliceClient, "POST", `${NS}.mint`, { body: {} });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = (await res.json()) as {
      communityDid: string;
      recoveryKey: unknown;
    };
    expect(data.communityDid).toMatch(/^did:plc:/);
    expect(data.recoveryKey).toBeTruthy();
    communityDid = data.communityDid;

    // bootstrapReservedSpaces creates the $admin space owned by `communityDid`
    // with Alice as the initial owner access-row.
    adminSpaceUri = `ats://${communityDid}/${SPACE_TYPE}/$admin`;
  });

  it("grants bob=manager and carol=member on the admin space", async () => {
    for (const [subject, level] of [
      [bob.did, "manager"],
      [carol.did, "member"],
    ] as const) {
      const res = await callAs(aliceClient, "POST", `${NS}.space.grant`, {
        body: {
          spaceUri: adminSpaceUri,
          subject: { did: subject },
          accessLevel: level,
        },
      });
      expect(res.status, `grant ${subject}=${level}: ${await res.clone().text()}`)
        .toBe(200);
    }
  });

  it("listMembers reflects the full ACL ladder", async () => {
    const res = await callAs(aliceClient, "GET", `${NS}.space.listMembers`, {
      query: { spaceUri: adminSpaceUri },
    });
    expect(res.status).toBe(200);
    const data = (await jsonOr(res)) as {
      rows: Array<{ subject: { did?: string }; accessLevel: string }>;
    };
    const byDid = Object.fromEntries(
      data.rows
        .filter((r) => r.subject.did)
        .map((r) => [r.subject.did, r.accessLevel]),
    );
    expect(byDid[alice.did]).toBe("owner");
    expect(byDid[bob.did]).toBe("manager");
    expect(byDid[carol.did]).toBe("member");
  });

  it("community.list returns the community for members but not strangers", async () => {
    // Alice is owner — should see the community.
    const aliceList = await callAs(aliceClient, "GET", `${NS}.list`);
    expect(aliceList.status).toBe(200);
    const { communities: aliceCommunities } = (await jsonOr(aliceList)) as {
      communities: Array<{ did: string }>;
    };
    expect(aliceCommunities.map((c) => c.did)).toContain(communityDid);

    // A fresh account with no grants — should see nothing.
    const stranger = await createTestAccount();
    const strangerClient = await login(stranger);
    const strangerList = await callAs(strangerClient, "GET", `${NS}.list`);
    expect(strangerList.status).toBe(200);
    const { communities: strangerCommunities } = (await jsonOr(strangerList)) as {
      communities: Array<{ did: string }>;
    };
    expect(strangerCommunities.map((c) => c.did)).not.toContain(communityDid);
  });

  it("promotes bob manager → admin via setAccessLevel", async () => {
    const res = await callAs(aliceClient, "POST", `${NS}.space.setAccessLevel`, {
      body: {
        spaceUri: adminSpaceUri,
        subject: { did: bob.did },
        accessLevel: "admin",
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const list = await callAs(aliceClient, "GET", `${NS}.space.listMembers`, {
      query: { spaceUri: adminSpaceUri },
    });
    const { rows } = (await jsonOr(list)) as {
      rows: Array<{ subject: { did?: string }; accessLevel: string }>;
    };
    expect(rows.find((r) => r.subject.did === bob.did)?.accessLevel).toBe("admin");
  });

  it("rejects a manager trying to grant admin (cannot-grant-higher-than-self)", async () => {
    // Bob is admin now; carol's still a member. Have bob try to promote carol
    // to owner — should 403 with cannot-grant-higher-than-self.
    const res = await callAs(bobClient, "POST", `${NS}.space.grant`, {
      body: {
        spaceUri: adminSpaceUri,
        subject: { did: carol.did },
        accessLevel: "owner",
      },
    });
    expect(res.status).toBe(403);
    const data = await jsonOr(res);
    expect(data.reason).toBe("cannot-grant-higher-than-self");
  });

  it("revokes carol cleanly (happy path)", async () => {
    const res = await callAs(aliceClient, "POST", `${NS}.space.revoke`, {
      body: { spaceUri: adminSpaceUri, subject: { did: carol.did } },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  // ----- last-owner guard ----------------------------------------------------
  // Removing or demoting the only `owner` on a space would leave it
  // unmanageable (and on $admin, the whole community ownerless). The router
  // refuses with 409 Conflict / reason: "last-owner" on both paths.

  it("space.revoke rejects removing the last owner", async () => {
    const res = await callAs(aliceClient, "POST", `${NS}.space.revoke`, {
      body: { spaceUri: adminSpaceUri, subject: { did: alice.did } },
    });
    expect(res.status).toBe(409);
    const data = (await jsonOr(res)) as { error: string; reason: string };
    expect(data.error).toBe("LastOwner");
    expect(data.reason).toBe("last-owner");
  });

  it("setAccessLevel rejects demoting the last owner", async () => {
    // Fresh community so the previous test's state doesn't interfere.
    const mint = await callAs(aliceClient, "POST", `${NS}.mint`, { body: {} });
    const { communityDid: freshDid } = (await mint.json()) as {
      communityDid: string;
    };
    const freshAdmin = `ats://${freshDid}/${SPACE_TYPE}/$admin`;

    const res = await callAs(aliceClient, "POST", `${NS}.space.setAccessLevel`, {
      body: {
        spaceUri: freshAdmin,
        subject: { did: alice.did },
        accessLevel: "manager",
      },
    });
    expect(res.status).toBe(409);
    const data = (await jsonOr(res)) as { error: string; reason: string };
    expect(data.error).toBe("LastOwner");
    expect(data.reason).toBe("last-owner");
  });

  // ----- ownership handoff via role rotation --------------------------------
  // The community DID stays put; ownership moves by promoting a successor to
  // `owner` and then demoting (or revoking) the original owner. Uses a fresh
  // community so the earlier tests' mutations don't interfere.

  it("hands off ownership by promoting a successor and demoting the original owner", async () => {
    const mint = await callAs(aliceClient, "POST", `${NS}.mint`, { body: {} });
    const { communityDid: freshDid } = (await mint.json()) as {
      communityDid: string;
    };
    const freshAdmin = `ats://${freshDid}/${SPACE_TYPE}/$admin`;

    // 1. Alice promotes Bob to owner (two owners now — no last-owner risk).
    const promote = await callAs(aliceClient, "POST", `${NS}.space.grant`, {
      body: {
        spaceUri: freshAdmin,
        subject: { did: bob.did },
        accessLevel: "owner",
      },
    });
    expect(promote.status, await promote.clone().text()).toBe(200);

    // 2. Bob demotes Alice to manager — he is now the sole owner.
    const demote = await callAs(bobClient, "POST", `${NS}.space.setAccessLevel`, {
      body: {
        spaceUri: freshAdmin,
        subject: { did: alice.did },
        accessLevel: "manager",
      },
    });
    expect(demote.status, await demote.clone().text()).toBe(200);

    // 3. Verify final state: Bob=owner, Alice=manager.
    const list = await callAs(bobClient, "GET", `${NS}.space.listMembers`, {
      query: { spaceUri: freshAdmin },
    });
    const { rows } = (await jsonOr(list)) as {
      rows: Array<{ subject: { did?: string }; accessLevel: string }>;
    };
    const byDid = Object.fromEntries(
      rows.filter((r) => r.subject.did).map((r) => [r.subject.did, r.accessLevel]),
    );
    expect(byDid[bob.did]).toBe("owner");
    expect(byDid[alice.did]).toBe("manager");
  });
});
