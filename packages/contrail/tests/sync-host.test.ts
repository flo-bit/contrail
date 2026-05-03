/** Tests for the recordHost.sync SSE endpoint. */

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import { HostedAdapter } from "../src/core/spaces/adapter";
import { registerRecordHostSyncRoutes } from "@atmo-dev/contrail-record-host";
import {
  generateAuthoritySigningKey,
  issueCredential,
  createInProcessVerifier,
  InMemoryPubSub,
  spaceTopic,
} from "@atmo-dev/contrail-base";
import type { CredentialKeyMaterial } from "@atmo-dev/contrail-base";
import { wrapWithPublishing } from "../src/core/realtime/publishing-adapter";

const ALICE = "did:plc:alice";
const SERVICE_DID = "did:web:test.example#svc";
const SPACE_TYPE = "tools.atmo.event.space";

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

const CONFIG: ContrailConfig = {
  namespace: "test.sync",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    authority: {
      type: SPACE_TYPE,
      serviceDid: SERVICE_DID,
      signing: undefined as any, // filled in beforeAll
    },
    recordHost: {},
  },
};

async function makeHost(): Promise<{
  app: Hono;
  adapter: HostedAdapter;
  pubsub: InMemoryPubSub;
  spaceUri: string;
}> {
  const db = createSqliteDatabase(":memory:");
  const cfg = { ...CONFIG };
  cfg.spaces!.authority!.signing = SIGNING;
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);

  const baseAdapter = new HostedAdapter(db, resolved);
  const pubsub = new InMemoryPubSub();
  // Wrap so writes also publish onto pubsub topics — mirrors what the
  // umbrella createApp does in realtime mode.
  const adapter = wrapWithPublishing(baseAdapter, pubsub) as HostedAdapter;

  // Create a space + enroll
  const spaceUri = `ats://${ALICE}/${SPACE_TYPE}/main`;
  await adapter.createSpace({
    uri: spaceUri,
    ownerDid: ALICE,
    type: SPACE_TYPE,
    key: "main",
    serviceDid: SERVICE_DID,
    appPolicyRef: null,
    appPolicy: null,
  });
  await adapter.addMember(spaceUri, ALICE, ALICE);
  await adapter.enroll({
    spaceUri,
    authorityDid: SERVICE_DID,
    enrolledAt: Date.now(),
    enrolledBy: ALICE,
  });

  // Build the SSE app.
  const app = new Hono();
  const verifier = createInProcessVerifier({
    authorityDid: SERVICE_DID,
    publicKey: SIGNING.publicKey,
  });
  registerRecordHostSyncRoutes(app, adapter, resolved, {
    db,
    pubsub,
    credentialVerifier: verifier,
    keepaliveMs: 60_000,
  });

  return { app, adapter, pubsub, spaceUri };
}

async function mintCredential(spaceUri: string): Promise<string> {
  const { credential } = await issueCredential(
    {
      iss: SERVICE_DID,
      sub: ALICE,
      space: spaceUri,
      scope: "rw",
      ttlMs: 60_000,
    },
    SIGNING
  );
  return credential;
}

/** Read the SSE response, return the first N parsed events. */
async function readEvents(
  res: Response,
  count: number,
  timeoutMs = 2000
): Promise<Array<{ kind: string; payload?: any; value?: string }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ kind: string; payload?: any; value?: string }> = [];
  let buf = "";
  const start = Date.now();
  while (events.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${count} events; got ${events.length}`);
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Skip comment-only blocks (`: open`, `: keepalive`).
      const dataLine = block
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      events.push(JSON.parse(json));
      if (events.length >= count) break;
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe("recordHost.sync — catch-up phase", () => {
  it("emits historical records as record.created in time_us order", async () => {
    const { app, adapter, spaceUri } = await makeHost();

    // Plant 3 records with deterministic timestamps.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await adapter.putRecord({
        spaceUri,
        collection: "app.event.message",
        authorDid: ALICE,
        rkey: `rk${i}`,
        cid: null,
        record: { $type: "app.event.message", text: `msg-${i}` },
        createdAt: now + i,
      });
    }

    const credential = await mintCredential(spaceUri);
    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.sync.recordHost.sync?spaceUri=${encodeURIComponent(spaceUri)}`,
        { headers: { "X-Space-Credential": credential } }
      )
    );
    expect(res.status).toBe(200);

    // Expect 3 record.created + at least one cursor checkpoint.
    const events = await readEvents(res, 4);
    const records = events.filter((e) => e.kind === "record.created");
    expect(records).toHaveLength(3);
    expect(records.map((e) => e.payload.rkey)).toEqual(["rk0", "rk1", "rk2"]);
    expect(records.every((e) => e.payload.space === spaceUri)).toBe(true);
    const cursors = events.filter((e) => e.kind === "cursor");
    expect(cursors.length).toBeGreaterThan(0);
  });

  it("respects the since cursor — records at or before are skipped", async () => {
    const { app, adapter, spaceUri } = await makeHost();

    const t0 = 1_700_000_000_000;
    await adapter.putRecord({
      spaceUri,
      collection: "app.event.message",
      authorDid: ALICE,
      rkey: "old",
      cid: null,
      record: { text: "old" },
      createdAt: t0,
    });
    await adapter.putRecord({
      spaceUri,
      collection: "app.event.message",
      authorDid: ALICE,
      rkey: "new",
      cid: null,
      record: { text: "new" },
      createdAt: t0 + 100,
    });

    const credential = await mintCredential(spaceUri);
    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.sync.recordHost.sync?spaceUri=${encodeURIComponent(spaceUri)}&since=${t0}`,
        { headers: { "X-Space-Credential": credential } }
      )
    );
    expect(res.status).toBe(200);

    const events = await readEvents(res, 2);
    const records = events.filter((e) => e.kind === "record.created");
    expect(records).toHaveLength(1);
    expect(records[0]!.payload.rkey).toBe("new");
  });
});

describe("recordHost.sync — auth + enrollment guards", () => {
  it("rejects without a credential", async () => {
    const { app, spaceUri } = await makeHost();
    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.sync.recordHost.sync?spaceUri=${encodeURIComponent(spaceUri)}`
      )
    );
    expect(res.status).toBe(401);
    expect((await res.json() as any).reason).toBe("credential-required");
  });

  it("rejects credential whose space doesn't match", async () => {
    const { app, spaceUri } = await makeHost();
    const wrongSpaceCred = await issueCredential(
      {
        iss: SERVICE_DID,
        sub: ALICE,
        space: "ats://did:plc:alice/x/y",
        scope: "rw",
        ttlMs: 60_000,
      },
      SIGNING
    );
    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.sync.recordHost.sync?spaceUri=${encodeURIComponent(spaceUri)}`,
        { headers: { "X-Space-Credential": wrongSpaceCred.credential } }
      )
    );
    expect(res.status).toBe(403);
    expect((await res.json() as any).reason).toBe("credential-wrong-space");
  });

  it("rejects un-enrolled spaces", async () => {
    const { app } = await makeHost();
    const otherSpaceUri = `ats://${ALICE}/${SPACE_TYPE}/different`;
    const cred = await issueCredential(
      {
        iss: SERVICE_DID,
        sub: ALICE,
        space: otherSpaceUri,
        scope: "rw",
        ttlMs: 60_000,
      },
      SIGNING
    );
    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.sync.recordHost.sync?spaceUri=${encodeURIComponent(otherSpaceUri)}`,
        { headers: { "X-Space-Credential": cred.credential } }
      )
    );
    expect(res.status).toBe(404);
    expect((await res.json() as any).reason).toBe("not-enrolled");
  });
});
