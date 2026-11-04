import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import type {
  AtprotoAudience,
  Did,
  Nsid,
} from "@atcute/lexicons/syntax";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { createApp } from "../src/core/router";
import {
  createCachedDidDocumentResolver,
  createExactServiceAuthGate,
} from "../src/core/service-auth";
import {
  initSchema,
  resolveConfig,
  type ContrailConfig,
  type Database,
} from "../src/index";

const issuer = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as Did;
const other = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" as Did;
const audience =
  "did:web:api.example.com#contrail" as AtprotoAudience;
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

async function token(
  lxm: string,
  options: { aud?: Did | AtprotoAudience; iss?: Did } = {},
) {
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
  it("verifies arbitrary configured extension method IDs", async () => {
    const method = "garden.atmo.circle.note.listSpaceRecords" as Nsid;
    const gate = createExactServiceAuthGate({
      audience,
      methods: [method],
      resolver: config().serviceAuth!.resolver,
    });
    const request = authorized(
      "https://api.example.com/xrpc/garden.atmo.circle.note.listSpaceRecords",
      await token(method),
    );
    const result = await gate.authorize(request, method);
    expect(result.response).toBeUndefined();
    expect(result.principal?.issuer).toBe(issuer);
    await expect(
      gate.authorize(request, "garden.atmo.circle.syncSpace" as Nsid),
    ).rejects.toThrow("not configured");
  });

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
          aud: "did:web:other.example.com#contrail" as AtprotoAudience,
        }),
      ),
    );
    expect(wrongAudience.status).toBe(401);

    const wrongFragment = await app.fetch(
      authorized(
        url,
        await token("com.example.getFeed", {
          aud: "did:web:api.example.com#other" as AtprotoAudience,
        }),
      ),
    );
    expect(wrongFragment.status).toBe(401);
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

  it("caches DID documents and honors signing-key refreshes", async () => {
    let calls = 0;
    const resolver = createCachedDidDocumentResolver({
      async resolve(did) {
        calls++;
        return {
          "@context": [],
          id: did,
          verificationMethod: [],
        };
      },
    });

    await resolver.resolve(issuer);
    await resolver.resolve(issuer);
    expect(calls).toBe(1);

    await resolver.resolve(issuer, { noCache: true });
    expect(calls).toBe(2);
    await resolver.resolve(issuer);
    expect(calls).toBe(2);
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
