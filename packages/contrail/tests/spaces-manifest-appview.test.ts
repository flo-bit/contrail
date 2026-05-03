/** Appview-side manifest consumption: cross-space listRecords union path
 *  honoring `X-Membership-Manifest`. */

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import {
  generateAuthoritySigningKey,
  issueMembershipManifest,
  markInProcess,
} from "@atmo-dev/contrail-base";
import type { CredentialKeyMaterial } from "@atmo-dev/contrail-base";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";

const SERVICE_DID = "did:web:test.example#svc";
const SPACE_TYPE = "tools.atmo.event.space";

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

function makeConfig(): ContrailConfig {
  return {
    namespace: "test.man2",
    collections: {
      message: { collection: "app.event.message" },
    },
    spaces: {
      authority: {
        type: SPACE_TYPE,
        serviceDid: SERVICE_DID,
        signing: SIGNING,
      },
      recordHost: {},
    },
  };
}

async function makeApp(): Promise<Hono> {
  const db = createSqliteDatabase(":memory:");
  const cfg = makeConfig();
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);
  return createApp(db, resolved);
}

/** Make a Request marked with an in-process principal so the union path's
 *  `verifyServiceAuthRequest` returns the right caller without minting a real
 *  JWT or wiring up a key resolver. */
function inProc(url: string, did: string, headers: Record<string, string> = {}): Request {
  const req = new Request(url, { headers });
  return markInProcess(req, did);
}

async function createSpace(app: Hono, owner: string, key: string): Promise<string> {
  const res = await app.fetch(
    markInProcess(
      new Request("http://localhost/xrpc/test.man2.space.createSpace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      }),
      owner
    )
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return body.space.uri;
}

async function plant(
  app: Hono,
  did: string,
  spaceUri: string,
  text: string
): Promise<void> {
  const res = await app.fetch(
    markInProcess(
      new Request("http://localhost/xrpc/test.man2.space.putRecord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaceUri,
          collection: "app.event.message",
          record: { $type: "app.event.message", text },
        }),
      }),
      did
    )
  );
  expect(res.status).toBe(200);
}

async function mintManifest(sub: string, spaces: string[]): Promise<string> {
  const { manifest } = await issueMembershipManifest(
    { iss: SERVICE_DID, sub, spaces, ttlMs: 60_000 },
    SIGNING
  );
  return manifest;
}

describe("appview union listRecords — manifest-driven", () => {
  it("uses manifest space list when valid + sub matches caller", async () => {
    const app = await makeApp();
    // Alice owns one space, Bob owns another.
    const aliceSpace = await createSpace(app, ALICE, "alice-only");
    const bobSpace = await createSpace(app, BOB, "bob-only");
    await plant(app, ALICE, aliceSpace, "from-alice");
    await plant(app, BOB, bobSpace, "from-bob");

    // Alice presents a manifest covering ONLY bobSpace (doesn't matter that
    // she's not actually a member — the manifest is the source of truth here).
    // The authority would never sign such a manifest in practice, but the
    // appview's contract is: trust the verified manifest's claims.
    const manifest = await mintManifest(ALICE, [bobSpace]);

    const res = await app.fetch(
      inProc(
        "http://localhost/xrpc/test.man2.message.listRecords",
        ALICE,
        { "X-Membership-Manifest": manifest }
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const texts = body.records.map((r: any) => r.value.text);
    expect(texts).toContain("from-bob");
    expect(texts).not.toContain("from-alice");
  });

  it("rejects manifest whose sub does not match the caller", async () => {
    const app = await makeApp();
    const aliceSpace = await createSpace(app, ALICE, "alice-only");
    await plant(app, ALICE, aliceSpace, "from-alice");

    // Bob's manifest, presented by Alice → should 403.
    const bobManifest = await mintManifest(BOB, [aliceSpace]);

    const res = await app.fetch(
      inProc(
        "http://localhost/xrpc/test.man2.message.listRecords",
        ALICE,
        { "X-Membership-Manifest": bobManifest }
      )
    );
    expect(res.status).toBe(403);
    expect((await res.json() as any).reason).toBe("manifest-sub-mismatch");
  });

  it("rejects an unsigned/forged manifest", async () => {
    const app = await makeApp();
    const otherKey = await generateAuthoritySigningKey();
    const { manifest } = await issueMembershipManifest(
      { iss: SERVICE_DID, sub: ALICE, spaces: [], ttlMs: 60_000 },
      otherKey
    );
    const res = await app.fetch(
      inProc(
        "http://localhost/xrpc/test.man2.message.listRecords",
        ALICE,
        { "X-Membership-Manifest": manifest }
      )
    );
    expect(res.status).toBe(401);
    expect((await res.json() as any).reason).toBe("bad-signature");
  });

  it("falls back to local listSpaces when no manifest is present", async () => {
    const app = await makeApp();
    const aliceSpace = await createSpace(app, ALICE, "alice-only");
    const bobSpace = await createSpace(app, BOB, "bob-only");
    await plant(app, ALICE, aliceSpace, "from-alice");
    await plant(app, BOB, bobSpace, "from-bob");

    // Alice queries with no manifest → local listSpaces returns aliceSpace only.
    const res = await app.fetch(
      inProc("http://localhost/xrpc/test.man2.message.listRecords", ALICE)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const texts = body.records.map((r: any) => r.value.text);
    expect(texts).toContain("from-alice");
    expect(texts).not.toContain("from-bob");
  });

  it("anonymous (no auth, no manifest) gets public results — no 401", async () => {
    const app = await makeApp();
    const aliceSpace = await createSpace(app, ALICE, "alice-only");
    await plant(app, ALICE, aliceSpace, "from-alice");

    const res = await app.fetch(
      new Request("http://localhost/xrpc/test.man2.message.listRecords")
    );
    // No auth header, no manifest → drops through to anonymous public path.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Private space records aren't visible publicly.
    const texts = (body.records ?? []).map((r: any) => r.value?.text);
    expect(texts).not.toContain("from-alice");
  });
});
