/** End-to-end multi-host sync test.
 *
 *  Two Contrail instances (host A and appview B) running in one process,
 *  each with its own SQLite DB. Host A creates a space and writes records.
 *  Appview B opens a sync stream against host A and ingests the records
 *  into its own tables. We verify B can query the records locally.
 *
 *  The "network" between them is host A's hono fetch, threaded through
 *  appview B's fetch parameter. Real deployments would use the actual
 *  fetch over HTTPS. */

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import { HostedAdapter } from "../src/core/spaces/adapter";
import { registerRecordHostSyncRoutes } from "@atmo-dev/contrail-record-host";
import { runRecordHostSync, applyRecordSyncSchema } from "@atmo-dev/contrail-appview";
import {
  generateAuthoritySigningKey,
  issueCredential,
  createInProcessVerifier,
  InMemoryPubSub,
} from "@atmo-dev/contrail-base";
import type { CredentialKeyMaterial } from "@atmo-dev/contrail-base";
import { wrapWithPublishing } from "../src/core/realtime/publishing-adapter";

const ALICE = "did:plc:alice";
const SERVICE_DID = "did:web:test.example#svc";
const SPACE_TYPE = "tools.atmo.event.space";
const SPACE_KEY = "main";
const SPACE_URI = `ats://${ALICE}/${SPACE_TYPE}/${SPACE_KEY}`;

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

const HOST_CONFIG: ContrailConfig = {
  namespace: "test.sync",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    authority: { type: SPACE_TYPE, serviceDid: SERVICE_DID },
    recordHost: {},
  },
};

async function makeHost(): Promise<{
  app: Hono;
  adapter: HostedAdapter;
  db: any;
}> {
  const db = createSqliteDatabase(":memory:");
  const cfg = { ...HOST_CONFIG };
  cfg.spaces!.authority!.signing = SIGNING;
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);

  const baseAdapter = new HostedAdapter(db, resolved);
  const pubsub = new InMemoryPubSub();
  const adapter = wrapWithPublishing(baseAdapter, pubsub) as HostedAdapter;

  // Provision a space + enroll on this host.
  await adapter.createSpace({
    uri: SPACE_URI,
    ownerDid: ALICE,
    type: SPACE_TYPE,
    key: SPACE_KEY,
    serviceDid: SERVICE_DID,
    appPolicyRef: null,
    appPolicy: null,
  });
  await adapter.addMember(SPACE_URI, ALICE, ALICE);
  await adapter.enroll({
    spaceUri: SPACE_URI,
    authorityDid: SERVICE_DID,
    enrolledAt: Date.now(),
    enrolledBy: ALICE,
  });

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
    batchSize: 50,
  });

  return { app, adapter, db };
}

async function makeAppview(): Promise<{ db: any; adapter: HostedAdapter; resolved: any }> {
  const db = createSqliteDatabase(":memory:");
  const cfg = { ...HOST_CONFIG };
  cfg.spaces!.authority!.signing = SIGNING;
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved, {
    extraSchemas: [applyRecordSyncSchema],
  });
  const adapter = new HostedAdapter(db, resolved);
  return { db, adapter, resolved };
}

async function mintCredentialForAlice(): Promise<string> {
  const { credential } = await issueCredential(
    {
      iss: SERVICE_DID,
      sub: ALICE,
      space: SPACE_URI,
      scope: "rw",
      ttlMs: 60_000,
    },
    SIGNING
  );
  return credential;
}

describe("recordHost.sync — end-to-end (host → appview)", () => {
  it("appview ingests historical records into its own tables", async () => {
    const host = await makeHost();
    const appview = await makeAppview();

    // Plant 3 records on the host.
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      await host.adapter.putRecord({
        spaceUri: SPACE_URI,
        collection: "app.event.message",
        authorDid: ALICE,
        rkey: `rk${i}`,
        cid: null,
        record: { $type: "app.event.message", text: `msg-${i}` },
        createdAt: t0 + i,
      });
    }

    // Appview opens a sync stream with a 200ms abort — long enough for
    // catch-up to drain, then we tear down before the live phase blocks.
    const ac = new AbortController();
    const credential = await mintCredentialForAlice();
    const cursors: string[] = [];

    const syncPromise = runRecordHostSync(
      {
        hostUrl: "http://host",
        spaceUri: SPACE_URI,
        authorityDid: SERVICE_DID,
        credential,
      },
      {
        db: appview.db,
        config: appview.resolved,
        recordHost: appview.adapter,
        // Route fetch to host A's hono app instead of the network.
        fetch: ((input: any, init?: any) => {
          const req = typeof input === "string" || input instanceof URL
            ? new Request(input, init)
            : (input as Request);
          return host.app.fetch(req);
        }) as typeof fetch,
        signal: ac.signal,
        onCursor: (c) => {
          cursors.push(c);
          // Once we've seen at least one cursor checkpoint, catch-up is
          // making progress. Schedule abort to break out of live mode.
          setTimeout(() => ac.abort(), 50);
        },
      }
    ).catch((err) => {
      // AbortError is expected; rethrow other errors.
      if (err.name !== "AbortError") throw err;
    });

    await syncPromise;

    // Verify the appview's local tables now have the host's records.
    const ingested = await appview.adapter.listRecords(
      SPACE_URI,
      "app.event.message"
    );
    expect(ingested.records).toHaveLength(3);
    expect(ingested.records.map((r) => r.rkey).sort()).toEqual([
      "rk0",
      "rk1",
      "rk2",
    ]);
    expect(cursors.length).toBeGreaterThan(0);

    // Cursor was persisted in the subscriptions table.
    const subRow = await appview.db
      .prepare(
        `SELECT cursor FROM record_sync_subscriptions WHERE host_url = ? AND space_uri = ?`
      )
      .bind("http://host", SPACE_URI)
      .first<{ cursor: string | null }>();
    expect(subRow?.cursor).toBeTruthy();

    // Auto-enrolled on the appview side.
    const enrollment = await appview.adapter.getEnrollment(SPACE_URI);
    expect(enrollment).toBeTruthy();
    expect(enrollment?.authorityDid).toBe(SERVICE_DID);
  });

  it("appview resumes from persisted cursor — no re-emission of old records", async () => {
    const host = await makeHost();
    const appview = await makeAppview();
    const credential = await mintCredentialForAlice();

    // First batch.
    const t0 = Date.now();
    await host.adapter.putRecord({
      spaceUri: SPACE_URI,
      collection: "app.event.message",
      authorDid: ALICE,
      rkey: "first",
      cid: null,
      record: { text: "first" },
      createdAt: t0,
    });

    const networkFetch = ((input: any, init?: any) => {
      const req = typeof input === "string" || input instanceof URL
        ? new Request(input, init)
        : (input as Request);
      return host.app.fetch(req);
    }) as typeof fetch;

    const ac1 = new AbortController();
    const seenCount: { count: number } = { count: 0 };
    await runRecordHostSync(
      {
        hostUrl: "http://host",
        spaceUri: SPACE_URI,
        authorityDid: SERVICE_DID,
        credential,
      },
      {
        db: appview.db,
        config: appview.resolved,
        recordHost: appview.adapter,
        fetch: networkFetch,
        signal: ac1.signal,
        onCursor: () => {
          seenCount.count++;
          setTimeout(() => ac1.abort(), 30);
        },
      }
    ).catch((err) => {
      if (err.name !== "AbortError") throw err;
    });

    // Insert second batch on the host AFTER the first sync completed.
    await host.adapter.putRecord({
      spaceUri: SPACE_URI,
      collection: "app.event.message",
      authorDid: ALICE,
      rkey: "second",
      cid: null,
      record: { text: "second" },
      createdAt: t0 + 100,
    });

    // Second sync run — should pick up only the new record, using the
    // persisted cursor.
    const ac2 = new AbortController();
    const ingestedRkeys: string[] = [];
    // Wrap putRecord to observe what gets re-ingested.
    const origPut = appview.adapter.putRecord.bind(appview.adapter);
    appview.adapter.putRecord = async (record) => {
      ingestedRkeys.push(record.rkey);
      return origPut(record);
    };

    await runRecordHostSync(
      {
        hostUrl: "http://host",
        spaceUri: SPACE_URI,
        authorityDid: SERVICE_DID,
        credential,
      },
      {
        db: appview.db,
        config: appview.resolved,
        recordHost: appview.adapter,
        fetch: networkFetch,
        signal: ac2.signal,
        onCursor: () => setTimeout(() => ac2.abort(), 30),
      }
    ).catch((err) => {
      if (err.name !== "AbortError") throw err;
    });

    // The second run should have ingested ONLY "second" (not re-ingested "first").
    expect(ingestedRkeys).toEqual(["second"]);
  });
});
