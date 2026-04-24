/**
 * Records written via {ns}.space.putRecord land in `spaces_records_<collection>`,
 * not `records_<collection>`. The public table must stay empty for the caller.
 *
 *   1. Alice creates a space and puts an event into it.
 *   2. Query postgres directly:
 *      - records_event            → 0 rows for alice.did
 *      - spaces_records_event     → 1 row with matching rkey and space_uri
 *
 * A leak between these tables would silently expose private records to any
 * public {ns}.event.getRecord / listRecords call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { CredentialManager, Client } from "@atcute/client";
import "@atcute/atproto";
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

describe("spaces table isolation", () => {
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

    const iso = await createIsolatedSchema("test_table_isolation");
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

  it("space records live in spaces_records_event, not records_event", async () => {
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
        record: {
          $type: EVENT_NSID,
          name: "isolation-target",
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(putRes.status, await putRes.clone().text().catch(() => "")).toBe(200);
    const { rkey } = (await putRes.json()) as { rkey: string };

    const publicRows = await pool.query(
      "SELECT COUNT(*)::int AS n FROM records_event WHERE did = $1",
      [alice.did],
    );
    expect(publicRows.rows[0].n, "records_event must not contain the space record").toBe(0);

    const spaceRows = await pool.query(
      "SELECT rkey, space_uri, did FROM spaces_records_event WHERE did = $1",
      [alice.did],
    );
    expect(spaceRows.rows).toHaveLength(1);
    expect(spaceRows.rows[0]).toMatchObject({
      rkey,
      space_uri: space.uri,
      did: alice.did,
    });
  });
});
