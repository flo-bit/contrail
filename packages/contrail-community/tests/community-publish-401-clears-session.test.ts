/** L6: A 401 from the publish path used to leave the bad session in the
 *  cache, so every subsequent publish hit the same 401 permanently. The fix
 *  is small: on 401, drop the cached session row. The next request goes cold
 *  through ensureSession, which mints a fresh session from the stored app
 *  password (or fails permanently if the app password itself was revoked). */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { initSchema } from "@atmo-dev/contrail";
import { createApp } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "../src/integration";
import { resolveConfig } from "@atmo-dev/contrail";
import type { ContrailConfig } from "@atmo-dev/contrail";
import {
  CommunityAdapter,
  CredentialCipher,
  RESERVED_KEYS,
} from "../src";
import { HostedAdapter } from "@atmo-dev/contrail";
import { buildSpaceUri } from "@atmo-dev/contrail";

const ALICE = "did:plc:alice";
const COMMUNITY_DID = "did:plc:l6comm";
const HANDLE = "l6.pds.test";
const PDS = "https://pds.example";
const MASTER_KEY = new Uint8Array(32).fill(13);
const APP_PASSWORD = "correct-pw";

function fakeAuth(spaceServiceDid: string): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", {
      issuer: did,
      audience: spaceServiceDid,
      lxm: undefined,
    });
    await next();
  };
}

async function build(): Promise<{ app: Hono; adapter: CommunityAdapter }> {
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith("/xrpc/com.atproto.repo.createRecord")) {
      return new Response(JSON.stringify({ error: "AuthRequired" }), {
        status: 401,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config: ContrailConfig = {
    namespace: "test.comm",
    collections: { message: { collection: "app.event.message" } },
    spaces: {
      authority: {
        type: "tools.atmo.event.space",
        serviceDid: "did:web:test.example#svc",
      },
      recordHost: {},
    },
    community: { masterKey: MASTER_KEY, fetch: fetchImpl },
  };
  const db = createSqliteDatabase(":memory:");
  const resolved = resolveConfig(config);
  const communityIntegration = createCommunityIntegration({ db, config: resolved });
  await initSchema(db, resolved, { extraSchemas: [communityIntegration.applySchema] });
  const app = createApp(db, resolved, {
    spaces: { authMiddleware: fakeAuth(config.spaces!.authority!.serviceDid) },
    community: communityIntegration,
  });

  const cipher = new CredentialCipher(MASTER_KEY);
  const community = new CommunityAdapter(db);
  const spaces = new HostedAdapter(db, resolved);
  await community.createFromProvisioned({
    did: COMMUNITY_DID,
    pdsEndpoint: PDS,
    handle: HANDLE,
    appPasswordEncrypted: await cipher.encrypt(APP_PASSWORD),
    createdBy: ALICE,
  });
  for (const key of RESERVED_KEYS) {
    const uri = buildSpaceUri({
      ownerDid: COMMUNITY_DID,
      type: config.spaces!.authority!.type,
      key,
    });
    await spaces.createSpace({
      uri,
      ownerDid: COMMUNITY_DID,
      type: config.spaces!.authority!.type,
      key,
      serviceDid: config.spaces!.authority!.serviceDid,
      appPolicyRef: null,
      appPolicy: null,
    });
    await community.grant({
      spaceUri: uri,
      subjectDid: ALICE,
      accessLevel: "owner",
      grantedBy: ALICE,
    });
    await spaces.applyMembershipDiff(uri, [ALICE], [], ALICE);
  }
  return { app, adapter: community };
}

describe("publish path: 401 clears the session cache (L6)", () => {
  let app: Hono;
  let adapter: CommunityAdapter;

  beforeEach(async () => {
    ({ app, adapter } = await build());
  });

  it("removes the cached session row when createRecord returns 401", async () => {
    // Seed a cached session that will be used (and rejected) by createRecord.
    await adapter.upsertSession(COMMUNITY_DID, {
      accessJwt: "stale-access",
      refreshJwt: "stale-refresh",
      accessExp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(await adapter.getSession(COMMUNITY_DID)).not.toBeNull();

    const res = await app.fetch(
      new Request("http://localhost/xrpc/test.comm.community.putRecord", {
        method: "POST",
        headers: { "X-Test-Did": ALICE, "Content-Type": "application/json" },
        body: JSON.stringify({
          communityDid: COMMUNITY_DID,
          collection: "app.event.message",
          record: { text: "hello" },
        }),
      })
    );
    expect(res.status).toBe(502);

    // The stale session must be gone, so the next attempt mints a fresh one.
    expect(await adapter.getSession(COMMUNITY_DID)).toBeNull();
  });
});
