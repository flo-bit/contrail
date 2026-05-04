/**
 * Shared test infrastructure for the contrail-e2e suite.
 *
 * The ingester and XRPC handler run in-process against an isolated pg schema
 * per test — no external processes required, and no collision with a
 * dogfooding ingester the developer might have running in another terminal.
 */
import pg from "pg";
import { CredentialManager, Client } from "@atcute/client";
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { Did as AtDid, Nsid } from "@atcute/lexicons";
import { Contrail, generateAuthoritySigningKey, resolveConfig } from "@atmo-dev/contrail";
import type { ContrailConfig, Database, SpacesConfig } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "@atmo-dev/contrail-community";

export type Did = `did:${string}:${string}`;

export const PDS_PORT = Number(process.env.DEVNET_PDS_PORT ?? 4000);
export const PDS_URL = `http://localhost:${PDS_PORT}`;
export const PLC_PORT = Number(process.env.DEVNET_PLC_PORT ?? 2582);
export const PLC_URL = `http://localhost:${PLC_PORT}`;
export const HANDLE_DOMAIN = process.env.DEVNET_HANDLE_DOMAIN ?? ".devnet.test";
export const PDS_ADMIN_PASSWORD = process.env.DEVNET_PDS_ADMIN_PASSWORD ?? "devnet-admin-password";
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/contrail";

/**
 * Arbitrary service DID used for the test Contrail deployment. The only
 * requirements: (a) the JWTs we mint via getServiceAuth use this as their
 * `aud` claim, and (b) Contrail's SpacesConfig.serviceDid matches. The DID
 * itself doesn't need to be resolvable — the verifier only resolves issuers
 * (users), not the audience.
 */
export const CONTRAIL_SERVICE_DID = "did:web:contrail-test.devnet.test";

/**
 * Resolver that points the PLC method at the local devnet PLC on :2582.
 * Without this, the default resolver hits plc.directory and 404s on every
 * devnet DID.
 */
export function createDevnetResolver() {
  return new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver({ apiUrl: PLC_URL }),
    },
  });
}

/**
 * Build a `spaces` config block in the post-PR30 split shape: authority owns
 * ACL + credential signing, recordHost owns storage. Tests that previously
 * passed the flat `{ type, serviceDid, resolver }` shape now get this — the
 * config validator enforces the split, and `community` requires `authority`.
 *
 * Pass the `type` NSID for the kind of space (e.g. "rsvp.atmo.event.space").
 * A fresh signing key is generated per call so credential issuance works in
 * the auth tests without leaking key material across suites.
 */
export async function makeSpacesConfig(type: string): Promise<SpacesConfig> {
  return {
    authority: {
      type,
      serviceDid: CONTRAIL_SERVICE_DID,
      signing: await generateAuthoritySigningKey(),
      resolver: createDevnetResolver(),
    },
    recordHost: {},
  };
}

/**
 * Build a Contrail wired with a community integration. Post-PR30, community
 * routes are not registered by passing a `community` config block alone — the
 * caller must construct a `CommunityIntegration` from the resolved config and
 * pass it as `communityIntegration` to the `Contrail` constructor (the same
 * pattern `createApp({ community })` uses in the contrail-community unit
 * tests).
 *
 * `community` is forwarded into the Contrail config so the integration can
 * read `masterKey`, `fetch`, etc. through `config.community`.
 */
export async function setupCommunityContrail(opts: {
  db: Database;
  baseConfig: ContrailConfig;
  spaceType: string;
  community: Record<string, unknown>;
}): Promise<Contrail> {
  const fullConfig: ContrailConfig = {
    ...opts.baseConfig,
    spaces: await makeSpacesConfig(opts.spaceType),
    community: opts.community,
  };
  const integration = createCommunityIntegration({
    db: opts.db,
    config: resolveConfig(fullConfig),
  });
  return new Contrail({
    ...fullConfig,
    db: opts.db,
    communityIntegration: integration,
  });
}

/**
 * Mint an atproto service-auth JWT via the PDS's getServiceAuth endpoint.
 * Requires the client to already be authed for a user. Returns the raw JWT
 * string suitable for `Authorization: Bearer <token>`.
 */
export async function mintServiceAuthJwt(
  client: Client,
  opts: { aud: string; lxm?: string; expSeconds?: number },
): Promise<string> {
  const params: { aud: AtDid; lxm?: Nsid; exp?: number } = {
    aud: opts.aud as AtDid,
  };
  if (opts.lxm) params.lxm = opts.lxm as Nsid;
  if (opts.expSeconds) params.exp = Math.floor(Date.now() / 1000) + opts.expSeconds;

  const res = await client.get("com.atproto.server.getServiceAuth", { params });
  if (!res.ok) {
    throw new Error(`getServiceAuth → ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data.token;
}

export type TestAccount = { handle: string; password: string; did: Did };

export async function createTestAccount(): Promise<TestAccount> {
  const inviteRes = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createInviteCode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`admin:${PDS_ADMIN_PASSWORD}`).toString("base64")}`,
    },
    body: JSON.stringify({ useCount: 1 }),
  });
  if (!inviteRes.ok) {
    throw new Error(`createInviteCode → ${inviteRes.status}: ${await inviteRes.text()}`);
  }
  const { code: inviteCode } = (await inviteRes.json()) as { code: string };

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const handle = `test-${suffix}${HANDLE_DOMAIN}`;
  const password = `pw-${suffix}`;

  const accountRes = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, email: `${suffix}@devnet.test`, password, inviteCode }),
  });
  if (!accountRes.ok) {
    throw new Error(`createAccount → ${accountRes.status}: ${await accountRes.text()}`);
  }
  const { did } = (await accountRes.json()) as { did: string };
  return { handle, password, did: did as Did };
}

/**
 * Create a fresh pg schema and return a Pool pinned to it via search_path.
 * Call the returned `cleanup` in afterAll to drop the schema.
 */
export async function createIsolatedSchema(
  prefix = "test",
): Promise<{ pool: pg.Pool; schemaName: string; cleanup: () => Promise<void> }> {
  const schemaName = `${prefix}_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const bootstrap = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrap.query(`CREATE SCHEMA "${schemaName}"`);
  await bootstrap.end();

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path="${schemaName}"`,
  });

  const cleanup = async () => {
    await pool.end();
    const c = new pg.Pool({ connectionString: DATABASE_URL });
    await c.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await c.end();
  };

  return { pool, schemaName, cleanup };
}

/**
 * Poll `fn` until it returns a defined value, or time out.
 *
 * Thrown errors count as "not yet" (last is included in the timeout message)
 * so transient 404s during startup don't abort. Use `label` to say what was
 * missing. Defaults (15s / 250ms) cover Contrail's 500ms test-mode flush plus
 * firehose propagation with plenty of headroom.
 */
export async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  { timeoutMs = 15_000, intervalMs = 250, label }: { timeoutMs?: number; intervalMs?: number; label: string },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor(${label}) timed out after ${timeoutMs}ms (${attempts} attempts)` +
      (lastErr ? `: ${(lastErr as Error).message}` : ""),
  );
}

/**
 * Log a TestAccount into the devnet PDS and return an authed atcute Client.
 */
export async function login(acct: TestAccount): Promise<Client> {
  const creds = new CredentialManager({ service: PDS_URL });
  await creds.login({ identifier: acct.handle, password: acct.password });
  return new Client({ handler: creds });
}

/**
 * A `fetch` shim that rewrites the unreachable `https://devnet.test` host
 * (which devnet PDSes publish in every DID document's `atproto_pds` service
 * entry) to the host-mapped `PDS_URL`. Pass this as `community.fetch` so the
 * credential check on adopt and the proxied createRecord on putRecord both
 * land on the local container instead of failing DNS.
 */
export const devnetRewriteFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.toString();
  return fetch(url.replace(/^https:\/\/devnet\.test/, PDS_URL), init);
};

/**
 * Fetch a record straight from the devnet PDS via `com.atproto.repo.getRecord`.
 * Used to confirm a proxied write (e.g. via `community.putRecord`) actually
 * landed on the PDS and not just contrail's local index.
 */
export async function getRecordFromPds(
  repo: string,
  collection: string,
  rkey: string,
): Promise<{ status: number; record?: any }> {
  const url =
    `${PDS_URL}/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(repo)}` +
    `&collection=${encodeURIComponent(collection)}` +
    `&rkey=${encodeURIComponent(rkey)}`;
  const res = await fetch(url);
  if (!res.ok) return { status: res.status };
  const body = (await res.json()) as { value: any };
  return { status: res.status, record: body.value };
}

/**
 * Mint an app password for `acct` via the PDS. Used by tests that need to
 * adopt the account as a community (the community module stores the app
 * password encrypted in its credential vault).
 */
export async function createAppPasswordFor(acct: TestAccount): Promise<string> {
  const c = await login(acct);
  const res = await c.post("com.atproto.server.createAppPassword", {
    input: { name: `e2e-${Date.now()}` },
  });
  if (!res.ok) {
    throw new Error(`createAppPassword: ${JSON.stringify(res.data)}`);
  }
  return res.data.password;
}

/**
 * A callAs function makes an XRPC call against the in-process Contrail
 * handler with a freshly minted service-auth JWT. Each call mints its own
 * token so the `lxm` claim binds to that specific endpoint.
 */
export type CallAs = (
  client: Client,
  method: "GET" | "POST",
  lxm: string,
  opts?: { body?: unknown; query?: Record<string, string> },
) => Promise<Response>;

/**
 * Create a caller bound to a specific in-process handler. Use one per test
 * file's `beforeAll` to avoid passing `handle` through every assertion.
 */
export function createCaller(
  handle: (req: Request) => Promise<Response>,
): CallAs {
  return async (client, method, lxm, opts = {}) => {
    const token = await mintServiceAuthJwt(client, {
      aud: CONTRAIL_SERVICE_DID,
      lxm,
    });
    const qs = opts.query
      ? "?" + new URLSearchParams(opts.query).toString()
      : "";
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return handle(
      new Request(`http://test/xrpc/${lxm}${qs}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  };
}

/**
 * Parse a Response body as JSON, throwing a clear error (with status + raw
 * text) if the body isn't JSON. Saves a `try/catch` in every assertion that
 * needs to inspect a 4xx/5xx body.
 */
export async function jsonOr(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response ${res.status}: ${text}`);
  }
}
