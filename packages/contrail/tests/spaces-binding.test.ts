import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import {
  createLocalBindingResolver,
  createOwnerSelfBindingResolver,
  createCompositeBindingResolver,
  createPdsBindingResolver,
  createDidDocBindingResolver,
  createLocalKeyResolver,
  createDidDocKeyResolver,
  createCompositeKeyResolver,
} from "../src/core/spaces/binding";
import {
  generateAuthoritySigningKey,
  issueCredential,
  createBindingCredentialVerifier,
} from "../src/core/spaces/credentials";
import type { CredentialKeyMaterial } from "../src/core/spaces/credentials";

const ALICE = "did:plc:alice";
const SERVICE_DID = "did:web:test.example#svc";

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

const SPACE_URI = "ats://did:plc:alice/com.example.event.space/main";

describe("BindingResolver — basic resolvers", () => {
  it("Local always returns the configured DID", async () => {
    const r = createLocalBindingResolver({ authorityDid: SERVICE_DID });
    expect(await r.resolveAuthority(SPACE_URI)).toBe(SERVICE_DID);
    expect(await r.resolveAuthority("ats://did:plc:bob/x/y")).toBe(SERVICE_DID);
  });

  it("OwnerSelf parses the owner from the URI", async () => {
    const r = createOwnerSelfBindingResolver();
    expect(await r.resolveAuthority(SPACE_URI)).toBe(ALICE);
    expect(await r.resolveAuthority("not a space uri")).toBeNull();
  });

  it("Composite returns the first non-null result", async () => {
    const r = createCompositeBindingResolver([
      { resolveAuthority: async () => null },
      { resolveAuthority: async () => "did:web:second" },
      { resolveAuthority: async () => "did:web:third" },
    ]);
    expect(await r.resolveAuthority(SPACE_URI)).toBe("did:web:second");
  });

  it("Composite returns null if every resolver returns null", async () => {
    const r = createCompositeBindingResolver([
      { resolveAuthority: async () => null },
      { resolveAuthority: async () => null },
    ]);
    expect(await r.resolveAuthority(SPACE_URI)).toBeNull();
  });
});

describe("BindingResolver — PDS record", () => {
  function mockResolver(opts: {
    pdsEndpoint?: string;
    fail?: boolean;
  }): any {
    return {
      resolve: async (did: string) => {
        if (opts.fail) throw new Error("nope");
        return {
          id: did,
          service: opts.pdsEndpoint
            ? [
                {
                  id: "#atproto_pds",
                  type: "AtprotoPersonalDataServer",
                  serviceEndpoint: opts.pdsEndpoint,
                },
              ]
            : [],
        };
      },
    };
  }

  function mockFetch(map: Map<string, any>): typeof fetch {
    return (async (url: string) => {
      const u = String(url);
      const found = [...map.entries()].find(([k]) => u.startsWith(k));
      if (!found) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(found[1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("reads `authority` from a declaration record", async () => {
    const fetch = mockFetch(
      new Map([
        [
          "https://pds.test/xrpc/com.atproto.repo.getRecord",
          {
            uri: "at://did:plc:alice/com.example.event.space/main",
            value: {
              $type: "com.example.event.space",
              authority: "did:web:custom-authority.example",
              recordHost: "did:web:host.example",
              createdAt: "2026-04-30T00:00:00Z",
            },
          },
        ],
      ])
    );
    const r = createPdsBindingResolver({
      resolver: mockResolver({ pdsEndpoint: "https://pds.test" }),
      fetch,
    });
    expect(await r.resolveAuthority(SPACE_URI)).toBe("did:web:custom-authority.example");
  });

  it("returns null when the PDS record is missing", async () => {
    const fetch = mockFetch(new Map()); // 404 for everything
    const r = createPdsBindingResolver({
      resolver: mockResolver({ pdsEndpoint: "https://pds.test" }),
      fetch,
    });
    expect(await r.resolveAuthority(SPACE_URI)).toBeNull();
  });

  it("returns null when the record has no authority field", async () => {
    const fetch = mockFetch(
      new Map([
        [
          "https://pds.test/xrpc/com.atproto.repo.getRecord",
          { value: { $type: "x", createdAt: "..." } },
        ],
      ])
    );
    const r = createPdsBindingResolver({
      resolver: mockResolver({ pdsEndpoint: "https://pds.test" }),
      fetch,
    });
    expect(await r.resolveAuthority(SPACE_URI)).toBeNull();
  });

  it("returns null when the owner DID doc has no PDS endpoint", async () => {
    const fetch = mockFetch(new Map());
    const r = createPdsBindingResolver({
      resolver: mockResolver({}),
      fetch,
    });
    expect(await r.resolveAuthority(SPACE_URI)).toBeNull();
  });
});

describe("BindingResolver — DID-doc service entry", () => {
  function mockResolver(serviceDid: string | null): any {
    return {
      resolve: async (did: string) => ({
        id: did,
        service: serviceDid
          ? [
              {
                id: "#atproto_space_authority",
                type: "AtprotoSpaceAuthority",
                serviceEndpoint: serviceDid,
              },
            ]
          : [],
      }),
    };
  }

  it("reads the #atproto_space_authority service entry", async () => {
    const r = createDidDocBindingResolver({
      resolver: mockResolver("did:web:authority.example"),
    });
    expect(await r.resolveAuthority(SPACE_URI)).toBe("did:web:authority.example");
  });

  it("returns null when the service entry is absent", async () => {
    const r = createDidDocBindingResolver({ resolver: mockResolver(null) });
    expect(await r.resolveAuthority(SPACE_URI)).toBeNull();
  });

  it("rejects URL-shaped service endpoints (must be a DID)", async () => {
    const r = createDidDocBindingResolver({
      resolver: mockResolver("https://authority.example.com"),
    });
    expect(await r.resolveAuthority(SPACE_URI)).toBeNull();
  });
});

describe("KeyResolver", () => {
  it("Local matches by DID", async () => {
    const r = createLocalKeyResolver({
      authorityDid: SERVICE_DID,
      publicKey: SIGNING.publicKey,
    });
    expect(await r.resolveKey(SERVICE_DID, undefined)).toEqual(SIGNING.publicKey);
    expect(await r.resolveKey("did:web:other", undefined)).toBeNull();
  });

  it("DidDoc finds the verification method matching kid", async () => {
    const otherKey = await generateAuthoritySigningKey();
    const resolver = {
      resolve: async (did: string) => ({
        id: did,
        verificationMethod: [
          {
            id: `${did}#atproto_space_authority`,
            type: "JsonWebKey2020",
            controller: did,
            publicKeyJwk: SIGNING.publicKey,
          },
          {
            id: `${did}#another-key`,
            type: "JsonWebKey2020",
            controller: did,
            publicKeyJwk: otherKey.publicKey,
          },
        ],
      }),
    };
    const r = createDidDocKeyResolver({ resolver: resolver as any });
    const key = await r.resolveKey(
      "did:web:authority.example",
      "did:web:authority.example#atproto_space_authority"
    );
    expect(key).toEqual(SIGNING.publicKey);
  });

  it("DidDoc returns the second key when kid points there", async () => {
    const otherKey = await generateAuthoritySigningKey();
    const resolver = {
      resolve: async (did: string) => ({
        id: did,
        verificationMethod: [
          {
            id: `${did}#atproto_space_authority`,
            type: "JsonWebKey2020",
            controller: did,
            publicKeyJwk: SIGNING.publicKey,
          },
          {
            id: `${did}#another-key`,
            type: "JsonWebKey2020",
            controller: did,
            publicKeyJwk: otherKey.publicKey,
          },
        ],
      }),
    };
    const r = createDidDocKeyResolver({ resolver: resolver as any });
    const key = await r.resolveKey(
      "did:web:authority.example",
      "did:web:authority.example#another-key"
    );
    expect(key).toEqual(otherKey.publicKey);
  });

  it("Composite walks resolvers in order", async () => {
    const fallback = await generateAuthoritySigningKey();
    const r = createCompositeKeyResolver([
      { resolveKey: async () => null },
      { resolveKey: async () => fallback.publicKey },
    ]);
    expect(await r.resolveKey("did:any", undefined)).toEqual(fallback.publicKey);
  });
});

describe("createBindingCredentialVerifier — composes binding + key resolvers", () => {
  it("verifies a credential whose iss matches the binding-resolved authority", async () => {
    const verifier = createBindingCredentialVerifier({
      bindings: createLocalBindingResolver({ authorityDid: SERVICE_DID }),
      keys: createLocalKeyResolver({
        authorityDid: SERVICE_DID,
        publicKey: SIGNING.publicKey,
      }),
    });
    const { credential } = await issueCredential(
      { iss: SERVICE_DID, sub: ALICE, space: SPACE_URI, scope: "rw", ttlMs: 60_000 },
      SIGNING
    );
    const result = await verifier.verify(credential);
    expect(result.ok).toBe(true);
  });

  it("rejects when credential iss disagrees with the binding", async () => {
    const verifier = createBindingCredentialVerifier({
      bindings: createLocalBindingResolver({ authorityDid: SERVICE_DID }),
      keys: createLocalKeyResolver({
        authorityDid: SERVICE_DID,
        publicKey: SIGNING.publicKey,
      }),
    });
    const { credential } = await issueCredential(
      {
        iss: "did:web:imposter.example",
        sub: ALICE,
        space: SPACE_URI,
        scope: "rw",
        ttlMs: 60_000,
      },
      SIGNING
    );
    const result = await verifier.verify(credential);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-issuer");
  });

  it("rejects when no resolver knows the authority", async () => {
    const verifier = createBindingCredentialVerifier({
      bindings: { resolveAuthority: async () => null },
      keys: { resolveKey: async () => null },
    });
    const { credential } = await issueCredential(
      { iss: SERVICE_DID, sub: ALICE, space: SPACE_URI, scope: "rw", ttlMs: 60_000 },
      SIGNING
    );
    const result = await verifier.verify(credential);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-issuer");
  });
});

describe("end-to-end — record host accepts credential from external authority", () => {
  function makeConfig(): ContrailConfig {
    return {
      namespace: "test.binding",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        authority: {
          type: "tools.atmo.event.space",
          serviceDid: SERVICE_DID,
          // No `signing` — this deployment is record-host only, accepting
          // credentials issued by an external authority.
        },
        recordHost: {},
      },
    };
  }

  function fakeAuth(): MiddlewareHandler {
    return async (c, next) => {
      const did = c.req.header("X-Test-Did");
      if (!did) return c.json({ error: "AuthRequired" }, 401);
      c.set("serviceAuth", {
        issuer: did,
        audience: SERVICE_DID,
        lxm: undefined,
        clientId: c.req.header("X-Test-App") ?? undefined,
      });
      await next();
    };
  }

  it("verifies a credential issued by a separate authority via injected verifier", async () => {
    // Set up: the record-host's verifier knows about an external authority
    // (did:web:external-authority.example) and where to find its public key.
    // No PDS / DID-doc fetches — the verifier is configured directly.
    const externalAuthority = "did:web:external-authority.example";
    const externalKey = SIGNING; // simulate operator-provided key material

    const verifier = createBindingCredentialVerifier({
      bindings: createLocalBindingResolver({ authorityDid: externalAuthority }),
      keys: createLocalKeyResolver({
        authorityDid: externalAuthority,
        publicKey: externalKey.publicKey,
      }),
    });

    const db = createSqliteDatabase(":memory:");
    const cfg = makeConfig();
    const resolved = resolveConfig(cfg);
    await initSchema(db, resolved);
    const app = createApp(db, resolved, {
      spaces: {
        authMiddleware: fakeAuth(),
        credentialVerifier: verifier,
      },
    });

    // Create a space directly in the local authority's tables. (In a real
    // split deployment, the authority would do this; the record host would
    // just enroll. Phase 5 introduces enrollment — for now, we use the
    // local authority routes as a stand-in.)
    const create = await app.fetch(
      new Request(`http://localhost/xrpc/test.binding.space.createSpace`, {
        method: "POST",
        headers: { "X-Test-Did": ALICE, "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(create.status).toBe(200);
    const uri = ((await create.json()) as any).space.uri;

    // External authority signs a credential.
    const { credential } = await issueCredential(
      {
        iss: externalAuthority,
        sub: ALICE,
        space: uri,
        scope: "rw",
        ttlMs: 60_000,
      },
      externalKey
    );

    // Record host accepts it on putRecord with no service-auth JWT.
    const put = await app.fetch(
      new Request(`http://localhost/xrpc/test.binding.space.putRecord`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Space-Credential": credential,
        },
        body: JSON.stringify({
          spaceUri: uri,
          collection: "app.event.message",
          record: { $type: "app.event.message", text: "hello" },
        }),
      })
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).authorDid).toBe(ALICE);
  });
});
