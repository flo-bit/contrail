import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { createApp } from "../src/core/router";
import {
  initSchema,
  resolveConfig,
  type ContrailConfig,
  type Database,
} from "../src/index";

const issuer = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as Did;
const other = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" as Did;
const audience = "did:web:api.example.com" as Did;
let keypair: Secp256k1PrivateKeyExportable;

beforeAll(async () => {
  keypair = await Secp256k1PrivateKeyExportable.createKeypair();
});

function config(): ContrailConfig {
  return {
    namespace: "com.example",
    profiles: [],
    notify: true,
    serviceAuth: {
      audience,
      methods: ["getFeed", "notifyOfUpdate"],
      resolver: {
        async resolve(did) {
          return {
            "@context": [],
            id: did,
            verificationMethod: [
              {
                id: `${did}#atproto`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase: await keypair.exportPublicKey("multikey"),
              },
            ],
          };
        },
      },
    },
    collections: {
      event: { collection: "community.example.event" },
      follow: {
        collection: "app.bsky.graph.follow",
        discover: false,
        subjectField: "subject",
        methods: [],
      },
    },
    feeds: { network: { targets: ["event"] } },
  };
}

async function setup(): Promise<{
  db: Database;
  app: ReturnType<typeof createApp>;
}> {
  const resolved = resolveConfig(config());
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, resolved);
  for (const did of [issuer, other]) {
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, NULL, ?, ?)",
      )
      .bind(did, "https://pds.example.com", Date.now())
      .run();
  }
  await db
    .prepare(
      "INSERT INTO feed_backfills (actor, feed, completed) VALUES (?, 'network', 1)",
    )
    .bind(issuer)
    .run();
  return { db, app: createApp(db, resolved) };
}

async function token(lxm: string, options: { aud?: Did; iss?: Did } = {}) {
  return createServiceJwt({
    keypair,
    issuer: options.iss ?? issuer,
    audience: options.aud ?? audience,
    lxm: lxm as Nsid,
  });
}

function authorized(url: string, jwt: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${jwt}`);
  return new Request(url, { ...init, headers });
}

describe("AT Protocol service auth", () => {
  it("requires exact audience and method-bound tokens", async () => {
    const { app } = await setup();
    const url = `https://api.example.com/xrpc/com.example.getFeed?feed=network&actor=${issuer}`;

    const missing = await app.fetch(new Request(url));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const wrongMethod = await app.fetch(
      authorized(url, await token("com.example.notifyOfUpdate")),
    );
    expect(wrongMethod.status).toBe(401);
    expect(wrongMethod.headers.get("www-authenticate")).toContain(
      "BadJwtLexiconMethod",
    );

    const wrongAudience = await app.fetch(
      authorized(
        url,
        await token("com.example.getFeed", {
          aud: "did:web:other.example.com" as Did,
        }),
      ),
    );
    expect(wrongAudience.status).toBe(401);
  });

  it("binds a personalized feed to the token issuer", async () => {
    const { app } = await setup();
    const jwt = await token("com.example.getFeed");

    const allowed = await app.fetch(
      authorized(
        `https://api.example.com/xrpc/com.example.getFeed?feed=network&actor=${issuer}`,
        jwt,
      ),
    );
    expect(allowed.status).toBe(200);

    const forbidden = await app.fetch(
      authorized(
        `https://api.example.com/xrpc/com.example.getFeed?feed=network&actor=${other}`,
        jwt,
      ),
    );
    expect(forbidden.status).toBe(403);
  });

  it("only lets an issuer notify its own record URIs", async () => {
    const { app } = await setup();
    const jwt = await token("com.example.notifyOfUpdate");
    const response = await app.fetch(
      authorized(
        "https://api.example.com/xrpc/com.example.notifyOfUpdate",
        jwt,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            uri: `at://${other}/community.example.event/1`,
          }),
        },
      ),
    );

    expect(response.status).toBe(403);
  });
});
