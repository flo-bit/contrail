import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import {
  registerAuthorityRoutes,
  registerRecordHostRoutes,
} from "../src/core/spaces/router";
import { HostedAdapter } from "../src/core/spaces/adapter";
import {
  buildVerifier,
  createServiceAuthMiddleware,
} from "../src/core/spaces/auth";
import {
  generateAuthoritySigningKey,
  issueCredential,
  createBindingCredentialVerifier,
} from "../src/core/spaces/credentials";
import {
  createEnrollmentBindingResolver,
  createLocalKeyResolver,
} from "../src/core/spaces/binding";
import type { CredentialKeyMaterial } from "../src/core/spaces/credentials";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const SERVICE_DID = "did:web:test.example#svc";

let SIGNING: CredentialKeyMaterial;

beforeAll(async () => {
  SIGNING = await generateAuthoritySigningKey();
});

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

function call(
  app: Hono,
  method: string,
  path: string,
  did: string | null,
  body?: any,
  extraHeaders?: Record<string, string>
) {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (did) headers["X-Test-Did"] = did;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

// ---------------------------------------------------------------------------
// In-process: createSpace auto-enrolls; non-enrolled spaces 404
// ---------------------------------------------------------------------------

describe("auto-enrollment via createSpace", () => {
  function makeConfig(): ContrailConfig {
    return {
      namespace: "test.enroll",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        authority: {
          type: "tools.atmo.event.space",
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
    return createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });
  }

  it("createSpace creates an enrollment row alongside the space row", async () => {
    const app = await makeApp();
    const create = await call(app, "POST", "/xrpc/test.enroll.space.createSpace", ALICE, {});
    expect(create.status).toBe(200);
    const uri = ((await create.json()) as any).space.uri;

    // Subsequent putRecord should succeed because the space is enrolled.
    const put = await call(app, "POST", "/xrpc/test.enroll.space.putRecord", ALICE, {
      spaceUri: uri,
      collection: "app.event.message",
      record: { $type: "app.event.message", text: "hi" },
    });
    expect(put.status).toBe(200);
  });

  it("explicit enroll via the endpoint is idempotent", async () => {
    const app = await makeApp();
    const create = await call(app, "POST", "/xrpc/test.enroll.space.createSpace", ALICE, {});
    const uri = ((await create.json()) as any).space.uri;

    // Re-enrolling the same space (e.g. to update the authority binding).
    const reenroll = await call(app, "POST", "/xrpc/test.enroll.recordHost.enroll", ALICE, {
      spaceUri: uri,
      authority: SERVICE_DID,
    });
    expect(reenroll.status).toBe(200);
    expect(((await reenroll.json()) as any).ok).toBe(true);
  });

  it("non-owner / non-authority callers cannot enroll", async () => {
    const app = await makeApp();
    const create = await call(app, "POST", "/xrpc/test.enroll.space.createSpace", ALICE, {});
    const uri = ((await create.json()) as any).space.uri;

    const res = await call(app, "POST", "/xrpc/test.enroll.recordHost.enroll", BOB, {
      spaceUri: uri,
      authority: SERVICE_DID,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not-owner-or-authority");
  });
});

// ---------------------------------------------------------------------------
// Split deployment: authority on machine A, record host on machine B
// ---------------------------------------------------------------------------

describe("split deployment — authority and record host on separate apps", () => {
  function buildAuthorityApp(db: any): Hono {
    const cfg: ContrailConfig = {
      namespace: "test.split",
      collections: { message: { collection: "app.event.message" } },
      // Authority-only deployment: no recordHost configured.
      spaces: {
        authority: {
          type: "tools.atmo.event.space",
          serviceDid: SERVICE_DID,
          signing: SIGNING,
        },
      },
    };
    const resolved = resolveConfig(cfg);
    const adapter = new HostedAdapter(db, resolved);
    const app = new Hono();
    registerAuthorityRoutes(
      app,
      adapter,
      cfg.spaces!.authority!,
      resolved,
      fakeAuth(),
      undefined,
      null // no local record host → no auto-enroll
    );
    return app;
  }

  function buildRecordHostApp(db: any): Hono {
    const cfg: ContrailConfig = {
      namespace: "test.split",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        // Authority config still required to provide the auth middleware
        // and serviceDid context, but signing can be omitted (host doesn't
        // sign — it verifies).
        authority: {
          type: "tools.atmo.event.space",
          serviceDid: SERVICE_DID,
        },
        recordHost: {},
      },
    };
    const resolved = resolveConfig(cfg);
    const adapter = new HostedAdapter(db, resolved);
    const verifier = createBindingCredentialVerifier({
      bindings: createEnrollmentBindingResolver({ recordHost: adapter }),
      keys: createLocalKeyResolver({
        authorityDid: SERVICE_DID,
        publicKey: SIGNING.publicKey,
      }),
    });
    const app = new Hono();
    registerRecordHostRoutes(
      app,
      adapter,
      adapter,
      cfg.spaces!.recordHost!,
      resolved,
      fakeAuth(),
      verifier
    );
    return app;
  }

  it("end-to-end: create on authority, enroll on host, write+read via credential", async () => {
    // Two physically-separate DBs — proves the host doesn't peek into the
    // authority's storage to know about spaces.
    const authorityDb = createSqliteDatabase(":memory:");
    const hostDb = createSqliteDatabase(":memory:");
    const cfg: ContrailConfig = {
      namespace: "test.split",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        authority: { type: "tools.atmo.event.space", serviceDid: SERVICE_DID, signing: SIGNING },
        recordHost: {},
      },
    };
    const resolved = resolveConfig(cfg);
    await initSchema(authorityDb, resolved);
    await initSchema(hostDb, resolved);

    const authorityApp = buildAuthorityApp(authorityDb);
    const hostApp = buildRecordHostApp(hostDb);

    // 1. Authority creates a space — auto-enroll did NOT happen because the
    //    authority has no local record host.
    const create = await call(authorityApp, "POST", "/xrpc/test.split.space.createSpace", ALICE, {});
    expect(create.status).toBe(200);
    const uri = ((await create.json()) as any).space.uri;

    // 2. Host rejects writes for the not-yet-enrolled space.
    //    The credential's binding resolver (EnrollmentBindingResolver)
    //    finds no enrollment → returns null → verifier 401 "unknown-issuer".
    //    This is a different layer than the requireEnrollment 404 (which
    //    fires on JWT/non-credential paths), but both block writes.
    const cred1 = await call(authorityApp, "POST", "/xrpc/test.split.space.getCredential", ALICE, {
      spaceUri: uri,
    });
    const credential = ((await cred1.json()) as any).credential;
    const earlyPut = await call(
      hostApp,
      "POST",
      "/xrpc/test.split.space.putRecord",
      null,
      { spaceUri: uri, collection: "app.event.message", record: { $type: "app.event.message", text: "x" } },
      { "X-Space-Credential": credential }
    );
    expect(earlyPut.status).toBe(401);
    expect((await earlyPut.json()).reason).toBe("unknown-issuer");

    // 3. Owner enrolls the space on the host.
    const enroll = await call(hostApp, "POST", "/xrpc/test.split.recordHost.enroll", ALICE, {
      spaceUri: uri,
      authority: SERVICE_DID,
    });
    expect(enroll.status).toBe(200);

    // 4. Now the host accepts writes via credential.
    const put = await call(
      hostApp,
      "POST",
      "/xrpc/test.split.space.putRecord",
      null,
      { spaceUri: uri, collection: "app.event.message", record: { $type: "app.event.message", text: "hello" } },
      { "X-Space-Credential": credential }
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).authorDid).toBe(ALICE);

    // 5. Read back via credential.
    const list = await call(
      hostApp,
      "GET",
      `/xrpc/test.split.space.listRecords?spaceUri=${encodeURIComponent(uri)}&collection=app.event.message`,
      null,
      undefined,
      { "X-Space-Credential": credential }
    );
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).records.length).toBe(1);
  });

  it("host rejects credentials whose iss doesn't match the enrollment", async () => {
    const authorityDb = createSqliteDatabase(":memory:");
    const hostDb = createSqliteDatabase(":memory:");
    const cfg: ContrailConfig = {
      namespace: "test.split",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        authority: { type: "tools.atmo.event.space", serviceDid: SERVICE_DID, signing: SIGNING },
        recordHost: {},
      },
    };
    const resolved = resolveConfig(cfg);
    await initSchema(authorityDb, resolved);
    await initSchema(hostDb, resolved);

    const authorityApp = buildAuthorityApp(authorityDb);
    const hostApp = buildRecordHostApp(hostDb);

    const create = await call(authorityApp, "POST", "/xrpc/test.split.space.createSpace", ALICE, {});
    const uri = ((await create.json()) as any).space.uri;
    await call(hostApp, "POST", "/xrpc/test.split.recordHost.enroll", ALICE, {
      spaceUri: uri,
      authority: SERVICE_DID,
    });

    // A credential signed by a *different* DID with the same key, but iss
    // doesn't match the enrolled authority.
    const { credential } = await issueCredential(
      {
        iss: "did:web:imposter.example",
        sub: ALICE,
        space: uri,
        scope: "rw",
        ttlMs: 60_000,
      },
      SIGNING
    );
    const res = await call(
      hostApp,
      "POST",
      "/xrpc/test.split.space.putRecord",
      null,
      { spaceUri: uri, collection: "app.event.message", record: { $type: "app.event.message", text: "x" } },
      { "X-Space-Credential": credential }
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("unknown-issuer");
  });

  it("non-enrolled spaces 404 with not-enrolled on JWT-path reads", async () => {
    // Service-auth JWTs go through requireEnrollment in the route handler,
    // so a non-enrolled space gives the explicit "not-enrolled" reason.
    const authorityDb = createSqliteDatabase(":memory:");
    const hostDb = createSqliteDatabase(":memory:");
    const cfg: ContrailConfig = {
      namespace: "test.split",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        authority: { type: "tools.atmo.event.space", serviceDid: SERVICE_DID, signing: SIGNING },
        recordHost: {},
      },
    };
    const resolved = resolveConfig(cfg);
    await initSchema(authorityDb, resolved);
    await initSchema(hostDb, resolved);
    const authorityApp = buildAuthorityApp(authorityDb);
    const hostApp = buildRecordHostApp(hostDb);
    const create = await call(authorityApp, "POST", "/xrpc/test.split.space.createSpace", ALICE, {});
    const uri = ((await create.json()) as any).space.uri;

    const list = await call(
      hostApp,
      "GET",
      `/xrpc/test.split.space.listRecords?spaceUri=${encodeURIComponent(uri)}&collection=app.event.message`,
      ALICE
    );
    expect(list.status).toBe(404);
    expect((await list.json()).reason).toBe("not-enrolled");
  });

  it("the declared authority can enroll a space without the owner's involvement", async () => {
    // Scenario: the authority service ('Contrail' in our naming) is a
    // separate DID and acts on behalf of an owner. The authority can enroll
    // because phase 5 accepts either owner-or-authority.
    const authorityDb = createSqliteDatabase(":memory:");
    const hostDb = createSqliteDatabase(":memory:");
    const cfg: ContrailConfig = {
      namespace: "test.split",
      collections: { message: { collection: "app.event.message" } },
      spaces: {
        authority: { type: "tools.atmo.event.space", serviceDid: SERVICE_DID, signing: SIGNING },
        recordHost: {},
      },
    };
    const resolved = resolveConfig(cfg);
    await initSchema(authorityDb, resolved);
    await initSchema(hostDb, resolved);

    const authorityApp = buildAuthorityApp(authorityDb);
    const hostApp = buildRecordHostApp(hostDb);
    const create = await call(authorityApp, "POST", "/xrpc/test.split.space.createSpace", ALICE, {});
    const uri = ((await create.json()) as any).space.uri;

    // Authority service identifies itself via the JWT issuer matching its DID.
    const enroll = await call(hostApp, "POST", "/xrpc/test.split.recordHost.enroll", SERVICE_DID, {
      spaceUri: uri,
      authority: SERVICE_DID,
    });
    expect(enroll.status).toBe(200);
  });
});
