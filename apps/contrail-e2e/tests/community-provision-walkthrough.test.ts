/**
 * Provisioned-community lifecycle walkthrough — the "happy day" the PR was
 * built for, end-to-end on the same handler.
 *
 * Each previous test pins one slice (provision-only, publishing-only,
 * ACL-only, ingest-only). This one chains them so a regression on any seam
 * between modules — provision → ACL → proxy publish → ingest of a RSVP from
 * a separate PDS repo — surfaces here even when each unit test still passes.
 *
 * Flow (each step is also asserted, so the test reads top-to-bottom as docs):
 *
 *   1. PROVISION — Alice calls `community.provision` with a caller-held
 *      P-256 rotation key (sovereign mode). Asserts: status=activated,
 *      DID well-formed, PLC log shows the caller's did:key at
 *      rotationKeys[0] (the sovereignty invariant).
 *
 *   2. GRANT — Alice grants Bob `member` on the community's `$publishers`
 *      space via `community.space.grant`. Asserts: listMembers shows Bob
 *      with accessLevel=member.
 *
 *   3. PUBLISH — Bob calls `community.putRecord` to write a public
 *      `community.lexicon.calendar.event` against the community DID's repo
 *      (proxied through Contrail's credential vault — Bob never holds the
 *      community's app password). Asserts: returned URI is rooted at the
 *      community DID; the record is visible via `com.atproto.repo.listRecords`
 *      against the community's PDS (proves the proxy actually wrote to the
 *      community repo, not a local index).
 *
 *   4. RSVP — Carol, a totally separate PDS account with no relationship
 *      to the community, writes a `community.lexicon.calendar.rsvp` to her
 *      own repo with `subject.uri = at://<communityDid>/.../<rkey>`.
 *      Anyone can RSVP — no grant required, that's the lexicon contract.
 *
 *   5. INDEX — The in-process ingester (Jetstream → Postgres) picks up both
 *      Bob's event and Carol's RSVP. Asserts: querying the event by URI
 *      shows rsvpsGoingCount=1, with the indexed event `did` being the
 *      community's DID (not Bob's, not Alice's).
 *
 * Prereqs: `pnpm stack:up` (devnet PDS+PLC + postgres reachable).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { Client } from "@atcute/client";
import "@atcute/atproto";
import {
  Contrail,
  generateKeyPair,
  runPersistent,
} from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config as baseConfig } from "../config";
import {
  CONTRAIL_SERVICE_DID,
  HANDLE_DOMAIN,
  PDS_ADMIN_PASSWORD,
  PDS_URL,
  PLC_URL,
  createCaller,
  createDevnetResolver,
  createIsolatedSchema,
  createTestAccount,
  devnetRewriteFetch,
  getRecordFromPds,
  jsonOr,
  login,
  waitFor,
  type CallAs,
  type TestAccount,
} from "./helpers";

const NS = `${baseConfig.namespace}.community`;
const SPACE_TYPE = "rsvp.atmo.event.space";
const EVENT_NSID = "community.lexicon.calendar.event";
const RSVP_NSID = "community.lexicon.calendar.rsvp";
const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

describe("community provision → grant → publish → RSVP walkthrough", () => {
  // Alice provisions the community (becomes owner of $admin and $publishers).
  // Bob is granted member on $publishers and publishes the event on behalf
  // of the community via the proxy. Carol is an arm's-length user on the
  // same PDS who RSVPs from her own repo — she has no grants on the
  // community, which is exactly the open-RSVP contract we want to pin.
  let alice: TestAccount;
  let bob: TestAccount;
  let carol: TestAccount;

  let aliceClient: Client;
  let bobClient: Client;
  let carolClient: Client;

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let pdsDid: string;
  let handle: (req: Request) => Promise<Response>;
  let callAs: CallAs;

  let ingestController: AbortController;
  let ingestPromise: Promise<void>;

  // Keypair held only by this test process; the public did:key is what we
  // pass to provision. The private JWK never leaves the test — that's the
  // sovereignty invariant we assert against the PLC log in step 1.
  let callerRotation: Awaited<ReturnType<typeof generateKeyPair>>;

  // Carried between tests in declaration order.
  let communityDid: string;
  let publishersUri: string;
  let eventUri: string;
  let eventCid: string;
  let eventRkey: string;

  beforeAll(async () => {
    // Discover the live PDS's DID — the orchestrator uses this as the `aud`
    // claim of the service-auth JWT it mints for createAccount, and the
    // devnet PDS validates `aud` against its own DID.
    const dres = await fetch(`${PDS_URL}/xrpc/com.atproto.server.describeServer`);
    if (!dres.ok) {
      throw new Error(
        `devnet PDS unreachable at ${PDS_URL}: ${dres.status} ${await dres.text()}`,
      );
    }
    pdsDid = ((await dres.json()) as { did?: string }).did!;

    [alice, bob, carol] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    aliceClient = await login(alice);
    bobClient = await login(bob);
    carolClient = await login(carol);

    callerRotation = await generateKeyPair();

    const iso = await createIsolatedSchema("test_provision_walkthrough");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);

    const contrail = new Contrail({
      ...baseConfig,
      db,
      spaces: {
        type: SPACE_TYPE,
        serviceDid: CONTRAIL_SERVICE_DID,
        resolver: createDevnetResolver(),
      },
      community: {
        // Provision uses serviceDid as the `aud` of its createAccount
        // service-auth JWT — must be the live PDS's DID, not the Contrail
        // service DID we use for inbound auth verification.
        serviceDid: pdsDid,
        masterKey: TEST_MASTER_KEY,
        plcDirectory: PLC_URL,
        resolver: createDevnetResolver(),
        // Devnet PDSes publish https://devnet.test in their DID document's
        // atproto_pds entry. Rewrite outgoing requests so the proxied
        // publish lands on the host-mapped port.
        fetch: devnetRewriteFetch,
      },
    });
    await contrail.init();
    handle = createHandler(contrail);
    callAs = createCaller(handle);

    // Run the ingester in-process so step 5 can see Carol's RSVP land in
    // the local index after she writes it directly to her PDS repo.
    ingestController = new AbortController();
    ingestPromise = runPersistent(db, baseConfig, {
      batchSize: 50,
      flushIntervalMs: 500,
      signal: ingestController.signal,
    });
  }, 30_000);

  afterAll(async () => {
    ingestController?.abort();
    await ingestPromise?.catch(() => {});
    await cleanupSchema?.();
  });

  // ----- helpers --------------------------------------------------------------

  async function getIndexedRecord(uri: string): Promise<any | undefined> {
    const url =
      `http://test/xrpc/${baseConfig.namespace}.event.getRecord?uri=${encodeURIComponent(uri)}`;
    const res = await handle(new Request(url));
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`getRecord ${uri} → ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  async function mintPdsInvite(): Promise<string> {
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createInviteCode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(
          `admin:${PDS_ADMIN_PASSWORD}`,
        ).toString("base64")}`,
      },
      body: JSON.stringify({ useCount: 1 }),
    });
    if (!res.ok) {
      throw new Error(`createInviteCode → ${res.status}: ${await res.text()}`);
    }
    return ((await res.json()) as { code: string }).code;
  }

  // ----- step 1: PROVISION ---------------------------------------------------
  // Sovereign provision: the caller passes the public did:key of a rotation
  // key they hold. Contrail mints a subordinate rotation key, lays down a
  // genesis op with [callerKey, contrailKey] in that order, then runs an
  // update op to install the PDS-recommended verification methods. The PLC
  // log must end with the caller's key still at rotationKeys[0] — without
  // that, recovery authority silently moved to Contrail.

  it("step 1 — provisions a sovereign community via XRPC and the PLC log shows the caller's rotation key first", async () => {
    const inviteCode = await mintPdsInvite();

    // Devnet PDS caps the local handle label at 18 chars. `pw-` prefix +
    // 8-char suffix keeps the full label well under that.
    const suffix = `${Date.now().toString(36).slice(-6)}${Math.random()
      .toString(36)
      .slice(2, 4)}`;
    const newHandle = `pw-${suffix}${HANDLE_DOMAIN}`;
    const email = `${suffix}@devnet.test`;
    const password = `pw-${suffix}`;

    const res = await callAs(aliceClient, "POST", `${NS}.provision`, {
      body: {
        handle: newHandle,
        email,
        password,
        inviteCode,
        pdsEndpoint: PDS_URL,
        rotationKey: callerRotation.publicDidKey,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { communityDid: string; status: string };
    expect(body.status).toBe("activated");
    expect(body.communityDid).toMatch(/^did:plc:[a-z2-7]{24}$/);
    communityDid = body.communityDid;

    // PLC sovereignty check: latest op (the post-activation update op) keeps
    // the caller's did:key at rotationKeys[0]. If this regresses, Contrail's
    // subordinate key would silently take rotation priority.
    const logRes = await fetch(`${PLC_URL}/${communityDid}/log`);
    expect(logRes.ok).toBe(true);
    const log = (await logRes.json()) as Array<{ rotationKeys: string[] }>;
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[log.length - 1]!.rotationKeys[0]).toBe(callerRotation.publicDidKey);

    publishersUri = `ats://${communityDid}/${SPACE_TYPE}/$publishers`;
  }, 30_000);

  // ----- step 2: GRANT -------------------------------------------------------
  // bootstrapReservedSpaces seeded $publishers with Alice as owner. To let
  // Bob publish on behalf of the community, Alice grants him `member` on
  // $publishers — the minimum level the putRecord guard accepts.

  it("step 2 — Alice grants Bob `member` on $publishers and listMembers reflects it", async () => {
    expect(communityDid, "step 1 must have provisioned the community").toBeTruthy();

    const res = await callAs(aliceClient, "POST", `${NS}.space.grant`, {
      body: {
        spaceUri: publishersUri,
        subject: { did: bob.did },
        accessLevel: "member",
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const list = await callAs(aliceClient, "GET", `${NS}.space.listMembers`, {
      query: { spaceUri: publishersUri },
    });
    expect(list.status).toBe(200);
    const { rows } = (await jsonOr(list)) as {
      rows: Array<{ subject: { did?: string }; accessLevel: string }>;
    };
    const byDid = Object.fromEntries(
      rows.filter((r) => r.subject.did).map((r) => [r.subject.did, r.accessLevel]),
    );
    expect(byDid[alice.did]).toBe("owner");
    expect(byDid[bob.did]).toBe("member");
  });

  // ----- step 3: PUBLISH -----------------------------------------------------
  // Bob calls community.putRecord. The router checks his level on
  // $publishers (member ≥ member, OK), pulls the community's encrypted
  // app password from the credential vault, opens a PDS session as the
  // community DID, and proxies a com.atproto.repo.createRecord. The
  // returned URI is rooted at the community DID — Bob never holds those
  // credentials, and his own DID doesn't appear anywhere in the record.

  it("step 3 — Bob (a $publishers member) publishes a public event as the community via proxy", async () => {
    expect(publishersUri, "step 2 must have granted bob").toBeTruthy();

    const eventName = `walkthrough-event ${Date.now()}`;
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await callAs(bobClient, "POST", `${NS}.putRecord`, {
      body: {
        communityDid,
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
    eventUri = out.uri;
    eventCid = out.cid;
    eventRkey = out.uri.split("/").pop()!;

    // URI is rooted at the community DID, not Bob's.
    expect(eventUri).toMatch(new RegExp(`^at://${communityDid}/${EVENT_NSID}/`));

    // The record is visible via the community PDS's listRecords — proves
    // the proxy actually wrote to the community repo, not just Contrail's
    // local index. listRecords is the lexicon endpoint the prompt named;
    // we round it out with a getRecord on the same rkey to confirm payload.
    const listUrl =
      `${PDS_URL}/xrpc/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(communityDid)}` +
      `&collection=${encodeURIComponent(EVENT_NSID)}` +
      `&limit=10`;
    const listRes = await fetch(listUrl);
    expect(listRes.ok, `listRecords ${listRes.status}`).toBe(true);
    const listed = (await listRes.json()) as {
      records: Array<{ uri: string; cid: string; value: { name?: string } }>;
    };
    const found = listed.records.find((r) => r.uri === eventUri);
    expect(found, `event ${eventUri} not in PDS listRecords`).toBeDefined();
    expect(found!.value.name).toBe(eventName);

    const onPds = await getRecordFromPds(communityDid, EVENT_NSID, eventRkey);
    expect(onPds.status).toBe(200);
    expect(onPds.record.name).toBe(eventName);
  }, 30_000);

  // ----- step 4: RSVP --------------------------------------------------------
  // Carol writes a community.lexicon.calendar.rsvp to her OWN repo on the
  // shared devnet PDS, with subject.uri pointing at the community's event.
  // She has zero relationship to the community — that's the open-RSVP
  // contract: anyone can RSVP, the record lives in the responder's repo.

  it("step 4 — Carol RSVPs from a separate PDS account by writing to her own repo", async () => {
    expect(eventUri, "step 3 must have published the event").toBeTruthy();

    const rsvpRes = await carolClient.post("com.atproto.repo.createRecord", {
      input: {
        repo: carol.did,
        collection: RSVP_NSID,
        record: {
          $type: RSVP_NSID,
          subject: { uri: eventUri, cid: eventCid },
          status: `${RSVP_NSID}#going`,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(rsvpRes.ok, `RSVP createRecord: ${JSON.stringify(rsvpRes.data)}`).toBe(true);
    if (!rsvpRes.ok) throw new Error("unreachable");
    expect(rsvpRes.data.uri).toMatch(new RegExp(`^at://${carol.did}/${RSVP_NSID}/`));
  });

  // ----- step 5: INDEX -------------------------------------------------------
  // Both records hit Jetstream and the in-process ingester. Querying the
  // event by URI from the local handler should hydrate rsvpsGoingCount=1
  // (Carol's RSVP referencing it), and the indexed `did` must be the
  // community's, not Bob's — proves end-to-end attribution works.

  it("step 5 — the indexer surfaces the event under the community DID with Carol's RSVP counted", async () => {
    expect(eventUri, "step 3 must have published the event").toBeTruthy();

    const indexed = await waitFor(
      async () => {
        const r = await getIndexedRecord(eventUri);
        return r && r.rsvpsGoingCount >= 1 ? r : undefined;
      },
      { label: `indexed ${eventUri} with rsvpsGoingCount>=1`, timeoutMs: 20_000 },
    );

    expect(indexed.uri).toBe(eventUri);
    // Attribution: the event belongs to the community, not the publisher.
    expect(indexed.did).toBe(communityDid);
    expect(indexed.did).not.toBe(bob.did);
    expect(indexed.did).not.toBe(alice.did);
    expect(indexed.rsvpsGoingCount).toBe(1);
  }, 30_000);
});
