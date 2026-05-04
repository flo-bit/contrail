/**
 * Service-auth JWT end-to-end against spaces XRPCs.
 *
 *   1. Alice mints a JWT via com.atproto.server.getServiceAuth, calls
 *      {ns}.space.createSpace → verifier accepts, space is created.
 *   2. JWT with wrong audience → verifier rejects, 401.
 *   3. JWT with lxm bound to one method, used on a different method → 401.
 *
 * The full auth path is exercised: PDS signs with Alice's PLC-published
 * key, Contrail's resolver reads that key from devnet PLC, real verifier
 * checks the signature. No mocks on the auth path.
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
  makeSpacesConfig,
  mintServiceAuthJwt,
  CONTRAIL_SERVICE_DID,
  PDS_URL,
  type TestAccount,
} from "./helpers";

const SPACE_TYPE = "rsvp.atmo.event.space";

describe("spaces auth (devnet PDS JWT → Contrail verifier)", () => {
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

    const iso = await createIsolatedSchema("test_spaces_auth");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);

    const contrail = new Contrail({
      ...baseConfig,
      db,
      spaces: await makeSpacesConfig(SPACE_TYPE),
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

  it("accepts a real service-auth JWT and creates a space", async () => {
    const token = await mintServiceAuthJwt(aliceClient, {
      aud: CONTRAIL_SERVICE_DID,
      lxm: "rsvp.atmo.space.createSpace",
    });

    const res = await callXrpc("POST", "/xrpc/rsvp.atmo.space.createSpace", {
      token,
      body: {},
    });
    const text = await res.clone().text().catch(() => "");
    expect(res.status, `createSpace → ${res.status}: ${text}`).toBe(200);

    const data = (await res.json()) as { space: { uri: string; ownerDid: string } };
    expect(data.space.uri).toMatch(/^ats:\/\//);
    expect(data.space.ownerDid).toBe(alice.did);
  });

  it("rejects a JWT minted with the wrong audience", async () => {
    const token = await mintServiceAuthJwt(aliceClient, {
      aud: "did:web:not-contrail.devnet.test",
    });

    const res = await callXrpc("POST", "/xrpc/rsvp.atmo.space.createSpace", {
      token,
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("rejects a JWT whose lxm binding mismatches the route", async () => {
    const token = await mintServiceAuthJwt(aliceClient, {
      aud: CONTRAIL_SERVICE_DID,
      lxm: "rsvp.atmo.space.listSpaces",
    });

    const res = await callXrpc("POST", "/xrpc/rsvp.atmo.space.createSpace", {
      token,
      body: {},
    });
    expect(res.status).toBe(401);
  });
});
