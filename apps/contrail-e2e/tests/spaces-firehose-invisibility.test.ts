/**
 * Records put into a private space must not appear on the ATProto firehose.
 *
 * Protocol:
 *   1. Subscribe to Jetstream filtered to Alice's DID + the event collection.
 *   2. Alice publishes a control record directly to her PDS → MUST appear
 *      on the firehose (proves the subscriber works).
 *   3. Alice puts a record into a space via {ns}.space.putRecord → MUST NOT
 *      appear on the firehose.
 *
 * Without (2) as a positive control, a silently broken subscriber would
 * make (3) vacuously true.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { CredentialManager, Client } from "@atcute/client";
import "@atcute/atproto";
import { JetstreamSubscription, type JetstreamEvent } from "@atcute/jetstream";
import type { Did as AtDid } from "@atcute/lexicons";
import { Contrail } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config as baseConfig } from "../config";
import {
  createTestAccount,
  createIsolatedSchema,
  createDevnetResolver,
  mintServiceAuthJwt,
  CONTRAIL_SERVICE_DID,
  PDS_URL,
  type TestAccount,
} from "./helpers";

const EVENT_NSID = "community.lexicon.calendar.event";
const SPACE_TYPE = "rsvp.atmo.event.space";
const JETSTREAM_URL = process.env.JETSTREAM_URL ?? "ws://localhost:6008/subscribe";
const PROPAGATION_MS = 2_500;

describe("spaces firehose invisibility", () => {
  let alice: TestAccount;
  let aliceClient: Client;
  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let handle: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    alice = await createTestAccount();
    const creds = new CredentialManager({ service: PDS_URL });
    await creds.login({ identifier: alice.handle, password: alice.password });
    aliceClient = new Client({ handler: creds });

    const iso = await createIsolatedSchema("test_firehose_invisibility");
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
    });
    await contrail.init();
    handle = createHandler(contrail);
  });

  afterAll(async () => {
    await cleanupSchema?.();
  });

  async function callXrpc(
    method: "GET" | "POST",
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return handle(
      new Request(`http://test${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  it("publishes PDS writes to firehose; space writes stay invisible", async () => {
    const observed = new Set<string>();
    const ac = new AbortController();
    const opened = deferred<void>();

    const sub = new JetstreamSubscription({
      url: JETSTREAM_URL,
      wantedCollections: [EVENT_NSID],
      wantedDids: [alice.did as unknown as AtDid],
      onConnectionOpen: () => opened.resolve(),
    });

    const collector = (async () => {
      const iterator = sub[Symbol.asyncIterator]();
      try {
        while (!ac.signal.aborted) {
          const result = await Promise.race([
            iterator.next(),
            new Promise<IteratorResult<JetstreamEvent>>((resolve) => {
              ac.signal.addEventListener(
                "abort",
                () => resolve({ value: undefined, done: true }),
                { once: true },
              );
            }),
          ]);
          if (result.done) break;
          const ev = result.value;
          if (ev.kind === "commit" && ev.did === alice.did) {
            observed.add(ev.commit.rkey);
          }
        }
      } finally {
        await iterator.return?.();
      }
    })();

    await opened.promise;

    // Control: direct PDS write must land on the firehose.
    const controlRes = await aliceClient.post("com.atproto.repo.createRecord", {
      input: {
        repo: alice.did,
        collection: EVENT_NSID as never,
        record: eventRecord("firehose-control"),
      },
    });
    expect(controlRes.ok, `control createRecord: ${JSON.stringify(controlRes.data)}`).toBe(true);
    if (!controlRes.ok) throw new Error("unreachable");
    const controlRkey = controlRes.data.uri.split("/").pop()!;

    // Private: space write must not.
    const createToken = await mintServiceAuthJwt(aliceClient, {
      aud: CONTRAIL_SERVICE_DID,
      lxm: "rsvp.atmo.space.createSpace",
    });
    const createRes = await callXrpc("POST", "/xrpc/rsvp.atmo.space.createSpace", {
      token: createToken,
      body: {},
    });
    expect(createRes.status).toBe(200);
    const { space } = (await createRes.json()) as { space: { uri: string } };

    const putToken = await mintServiceAuthJwt(aliceClient, {
      aud: CONTRAIL_SERVICE_DID,
      lxm: "rsvp.atmo.space.putRecord",
    });
    const putRes = await callXrpc("POST", "/xrpc/rsvp.atmo.space.putRecord", {
      token: putToken,
      body: {
        spaceUri: space.uri,
        collection: EVENT_NSID,
        record: eventRecord("private-in-space"),
      },
    });
    const putText = await putRes.clone().text().catch(() => "");
    expect(putRes.status, `space.putRecord → ${putRes.status}: ${putText}`).toBe(200);
    const { rkey: spaceRkey } = (await putRes.json()) as { rkey: string };

    await new Promise((r) => setTimeout(r, PROPAGATION_MS));

    ac.abort();
    await collector;

    expect(
      observed.has(controlRkey),
      `control PDS record ${controlRkey} must appear on firehose; observed: ${[...observed].join(",") || "(none)"}`,
    ).toBe(true);
    expect(
      observed.has(spaceRkey),
      `space record ${spaceRkey} must NOT appear on firehose`,
    ).toBe(false);
  });
});

function eventRecord(name: string) {
  return {
    $type: EVENT_NSID,
    name,
    createdAt: new Date().toISOString(),
    startsAt: new Date(Date.now() + 60_000).toISOString(),
    mode: `${EVENT_NSID}#inperson`,
    status: `${EVENT_NSID}#scheduled`,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
