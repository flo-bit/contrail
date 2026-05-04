/**
 * Community publishing end-to-end.
 *
 * Pins the proxy path that's unique to the community module: caller's JWT →
 * encrypted app-password decrypt → PDS session → `com.atproto.repo.createRecord`
 * with the **community** DID as `repo` → Jetstream propagation → indexer.
 * Four real systems on a single hot path.
 *
 * Each published record gets a 4-way check:
 *   1. `community.putRecord` returns 200 with `{ uri, cid }`.
 *   2. The record exists at the PDS (`com.atproto.repo.getRecord`) — proves
 *      the proxy actually wrote, not just contrail's local store.
 *   3. The record appears in the contrail index — proves Jetstream + ingest.
 *   4. The indexed `did` is the community DID, not the caller's DID.
 *
 * Plus: minted-community publishing returns NotSupported (no PDS to proxy
 * to); a non-publisher gets 403; deleteRecord cleans both PDS and index.
 *
 * Prereqs: `pnpm stack:up`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { Client } from "@atcute/client";
import "@atcute/atproto";
import { runPersistent } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config as baseConfig } from "../config";
import {
  createTestAccount,
  createIsolatedSchema,
  createDevnetResolver,
  setupCommunityContrail,
  createCaller,
  createAppPasswordFor,
  devnetRewriteFetch,
  getRecordFromPds,
  login,
  CONTRAIL_SERVICE_DID,
  waitFor,
  type CallAs,
  type TestAccount,
} from "./helpers";

const NS = `${baseConfig.namespace}.community`;
const SPACE_TYPE = "rsvp.atmo.event.space";
const EVENT_NSID = "community.lexicon.calendar.event";
const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

describe("community publishing (proxy → PDS → Jetstream → index)", () => {
  let alice: TestAccount;     // owner of community spaces (caller)
  let bob: TestAccount;       // account adopted as the community
  let charlie: TestAccount;   // outsider — no grants on the community

  let aliceClient: Client;
  let charlieClient: Client;
  let bobAppPassword: string;

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let handle: (req: Request) => Promise<Response>;
  let callAs: CallAs;
  let ingestController: AbortController;
  let ingestPromise: Promise<void>;

  let adoptedCommunityDid: string;
  let publishedUri: string;
  let publishedRkey: string;

  beforeAll(async () => {
    [alice, bob, charlie] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    aliceClient = await login(alice);
    charlieClient = await login(charlie);

    // Bob mints an app password — that's what gets stored encrypted in the
    // credential vault and used for every proxied write.
    bobAppPassword = await createAppPasswordFor(bob);

    const iso = await createIsolatedSchema("test_community_publishing");
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
        // Devnet PDS publishes "https://devnet.test" as its public endpoint
        // in every DID document, which isn't reachable from the test
        // process. Rewrite outgoing requests so the credential check on
        // adopt and the proxied createRecord on putRecord both hit the
        // host-mapped port instead.
        fetch: devnetRewriteFetch,
      },
    });
    await contrail.init();
    handle = createHandler(contrail);
    callAs = createCaller(handle);

    ingestController = new AbortController();
    ingestPromise = runPersistent(db, baseConfig, {
      batchSize: 50,
      flushIntervalMs: 500,
      signal: ingestController.signal,
    });

    // Alice adopts Bob's account as the community. Alice becomes owner of
    // both $admin and $publishers via bootstrapReservedSpaces. Pass Bob's
    // DID rather than his handle — devnet handles aren't resolvable via
    // the public /.well-known path that resolveIdentity falls back to.
    const adopt = await callAs(aliceClient, "POST", `${NS}.adopt`, {
      body: { identifier: bob.did, appPassword: bobAppPassword },
    });
    expect(adopt.status, await adopt.clone().text()).toBe(200);
    const data = (await adopt.json()) as { communityDid: string };
    adoptedCommunityDid = data.communityDid;
    expect(adoptedCommunityDid).toBe(bob.did);
  });

  afterAll(async () => {
    ingestController?.abort();
    await ingestPromise?.catch(() => {});
    await cleanupSchema?.();
  });

  // ----- helpers ------------------------------------------------------------

  /** Look up the record in the contrail index via the local XRPC handler. */
  async function getIndexedRecord(uri: string): Promise<any | undefined> {
    const url = `http://test/xrpc/${baseConfig.namespace}.event.getRecord?uri=${encodeURIComponent(uri)}`;
    const res = await handle(new Request(url));
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`getRecord ${uri} → ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  // ----- happy path: adopted community publishes a public event -------------

  it("publishes via community.putRecord and lands at PDS, Jetstream, and index", async () => {
    const eventName = `community-published ${Date.now()}`;
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await callAs(aliceClient, "POST", `${NS}.putRecord`, {
      body: {
        communityDid: adoptedCommunityDid,
        collection: EVENT_NSID,
        record: {
          $type: EVENT_NSID,
          name: eventName,
          createdAt: new Date().toISOString(),
          startsAt,
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const out = (await res.json()) as { uri: string; cid: string };
    publishedUri = out.uri;
    publishedRkey = out.uri.split("/").pop()!;

    // (1) URI is rooted at the community's DID, not Alice's. `at://` is
    // intentional here — this is a PDS-issued record URI, distinct from
    // the `ats://` scheme used for Contrail-internal space URIs.
    expect(publishedUri).toMatch(new RegExp(`^at://${adoptedCommunityDid}/${EVENT_NSID}/`));

    // (2) PDS actually has it — proves the proxy wrote, not just the local DB.
    const pds = await getRecordFromPds(adoptedCommunityDid, EVENT_NSID, publishedRkey);
    expect(pds.status).toBe(200);
    expect(pds.record.name).toBe(eventName);

    // (3) Index has it — proves Jetstream + ingester.
    // (4) Indexed `did` is the community DID, not the caller's DID.
    const indexed = await waitFor(
      () => getIndexedRecord(publishedUri),
      { label: `index ${publishedUri}` },
    );
    expect(indexed.did).toBe(adoptedCommunityDid);
    expect(indexed.did).not.toBe(alice.did);
    expect(indexed.value.name).toBe(eventName);
  });

  // ----- authorization: non-member can't publish on behalf of community -----

  it("rejects publishing from a caller not in $publishers", async () => {
    const res = await callAs(charlieClient, "POST", `${NS}.putRecord`, {
      body: {
        communityDid: adoptedCommunityDid,
        collection: EVENT_NSID,
        record: {
          $type: EVENT_NSID,
          name: "should never land",
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { reason: string };
    expect(data.reason).toBe("not-in-publishers");
  });

  // ----- delete roundtrip: PDS + index both clear --------------------------

  it("deletes a published record from both PDS and index", async () => {
    expect(publishedRkey, "previous test must have published").toBeTruthy();

    const res = await callAs(aliceClient, "POST", `${NS}.deleteRecord`, {
      body: {
        communityDid: adoptedCommunityDid,
        collection: EVENT_NSID,
        rkey: publishedRkey,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const pds = await getRecordFromPds(adoptedCommunityDid, EVENT_NSID, publishedRkey);
    expect(pds.status).toBe(400); // PDS returns 400 RecordNotFound, not 404

    await waitFor(
      async () => ((await getIndexedRecord(publishedUri)) === undefined ? true : undefined),
      { label: `index drops ${publishedUri}` },
    );
  });

  // ----- minted communities have no PDS to proxy to ------------------------
  // A minted community is a contrail-controlled DID with no `atproto_pds`
  // service entry, so there's no repo to write into. `community.putRecord`
  // returns NotSupported. If minted publishing ever lands (e.g. by routing
  // writes to a community-owned repo), update this assertion.

  it("minted communities cannot publish public records", async () => {
    const mint = await callAs(aliceClient, "POST", `${NS}.mint`, { body: {} });
    expect(mint.status).toBe(200);
    const { communityDid: mintedDid } = (await mint.json()) as {
      communityDid: string;
    };

    const res = await callAs(aliceClient, "POST", `${NS}.putRecord`, {
      body: {
        communityDid: mintedDid,
        collection: EVENT_NSID,
        record: {
          $type: EVENT_NSID,
          name: "should never publish",
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; reason: string };
    expect(data.error).toBe("NotSupported");
    expect(data.reason).toBe("publishing-not-supported-for-minted-communities");
  });
});
