import type {} from "@atcute/atproto";
import {
  Client,
  simpleFetchHandler,
  type FetchHandler,
} from "@atcute/client";
import { isDid, type Did, type Nsid } from "@atcute/lexicons/syntax";
import {
  isPublicServiceManifest,
  normalizePublicServiceEndpoint,
  type PublicServiceAuthContract,
} from "./public-service.js";

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_SKEW_MS = 5_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

class PublicServiceContractError extends Error {}

export interface PublicServiceClientOptions {
  /** Canonical public Contrail HTTPS origin. */
  endpoint: string;
  /** Existing authenticated AT Protocol client used to mint service tokens.
   *  Omit when the consumer only needs anonymous methods. */
  authenticatedClient?: Client;
  /** Optional contract pin from `contrail.lock.json`. */
  contractDigest?: string;
  /** Optional receiving-service DID from `lex.config.js`. Supplying it also
   *  makes the required OAuth permission available as `client.scope`. */
  serviceDid?: Did;
  /** Optional precomputed OAuth permission. Must match `serviceDid`. */
  scope?: `rpc?lxm=*&aud=${string}`;
  /** Exact XRPC methods served by this provider. Supplying the verified list
   *  lets authenticated clients route all other methods to the user's PDS. */
  serviceMethods?: readonly Nsid[];
  /** Record collections whose successful PDS writes should notify Contrail. */
  collections?: readonly Nsid[];
  /** Protected notification procedure advertised by the provider. */
  notifyMethod?: Nsid;
  /** Browser, test, or instrumented fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Permit plain HTTP only on a loopback host for local development. */
  allowInsecureHttp?: boolean;
}

export interface PublicServiceNotificationErrorContext {
  method: Nsid;
  uris: readonly string[];
}

export interface PublicServiceAuthenticatedOptions {
  onNotificationError?: (
    error: unknown,
    context: PublicServiceNotificationErrorContext,
  ) => void;
}

export type PublicServiceClient = Client & {
  /** Canonical public Contrail origin. */
  readonly endpoint: string;
  /** OAuth permission required by protected methods, or null when unconfigured. */
  readonly scope: `rpc?lxm=*&aud=${string}` | null;
  /** Record collections whose successful writes trigger notification. */
  readonly collections: readonly Nsid[];
  /** Combine this provider with an authenticated PDS client. Provider methods
   *  route to Contrail; other methods route to the PDS; successful tracked
   *  record writes notify Contrail before returning their original response. */
  authenticated(
    authenticatedClient: Client,
    options?: PublicServiceAuthenticatedOptions,
  ): PublicServiceClient;
};

export function publicServiceOAuthScope(
  audience: Did,
): `rpc?lxm=*&aud=${string}` {
  return `rpc?lxm=*&aud=${audience}`;
}

function xrpcMethod(pathname: string): Nsid | null {
  const path = pathname.startsWith("http")
    ? new URL(pathname).pathname
    : new URL(pathname, "https://contrail.invalid").pathname;
  const prefix = "/xrpc/";
  if (!path.startsWith(prefix)) return null;
  try {
    const method = decodeURIComponent(path.slice(prefix.length));
    return method.includes("/") ? null : (method as Nsid);
  } catch {
    return null;
  }
}

function tokenExpiration(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return Date.now() + 30_000;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isSafeInteger(payload.exp)
      ? payload.exp * 1_000
      : Date.now() + 30_000;
  } catch {
    return Date.now() + 30_000;
  }
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** Fetch handler that verifies an optional pinned contract once, then keeps
 * unpinned anonymous reads cheap while automatically minting, caching, and
 * attaching method-bound AT Protocol service tokens after a protected route
 * challenges the first request. */
export function publicServiceFetchHandler(
  options: PublicServiceClientOptions,
): FetchHandler {
  const endpoint = normalizePublicServiceEndpoint(options.endpoint, options);
  const fetcher = options.fetch ?? fetch;
  const base = simpleFetchHandler({ service: endpoint, fetch: fetcher });
  const tokens = new Map<string, CachedToken>();
  const pendingTokens = new Map<string, Promise<string>>();
  let serviceAuthPromise: Promise<PublicServiceAuthContract | null> | null = null;

  const discoverServiceAuth = () => {
    if (serviceAuthPromise) return serviceAuthPromise;
    const pending = (async () => {
      const response = await fetcher(`${endpoint}/.well-known/contrail`, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Contrail discovery failed: ${response.status}`);
      }
      if (response.url && new URL(response.url).origin !== endpoint) {
        throw new PublicServiceContractError(
          "Contrail discovery redirected to a different origin",
        );
      }
      const value: unknown = await response.json();
      if (!isPublicServiceManifest(value)) {
        throw new PublicServiceContractError(
          "response is not a supported Contrail service manifest",
        );
      }
      if (normalizePublicServiceEndpoint(value.endpoint, options) !== endpoint) {
        throw new PublicServiceContractError(
          "Contrail manifest endpoint mismatch",
        );
      }
      if (
        options.contractDigest &&
        value.contract.digest !== options.contractDigest
      ) {
        throw new PublicServiceContractError(
          `Contrail contract digest mismatch: expected ${options.contractDigest}, received ${value.contract.digest}`,
        );
      }
      const serviceAuth = value.serviceAuth ?? null;
      if (
        options.serviceDid &&
        serviceAuth?.audience !== options.serviceDid
      ) {
        throw new PublicServiceContractError(
          `Contrail service DID mismatch: expected ${options.serviceDid}, received ${serviceAuth?.audience ?? "none"}`,
        );
      }
      return serviceAuth;
    })();
    const cached = pending.catch((error: unknown) => {
      if (
        !(error instanceof PublicServiceContractError) &&
        serviceAuthPromise === cached
      ) {
        serviceAuthPromise = null;
      }
      throw error;
    });
    serviceAuthPromise = cached;
    return cached;
  };

  const protectedMethod = async (method: string) => {
    const auth = await discoverServiceAuth();
    return auth?.methods.some((candidate) => candidate.id === method)
      ? auth
      : null;
  };

  const tokenFor = async (
    method: Nsid,
    auth: PublicServiceAuthContract,
    force = false,
  ): Promise<string> => {
    if (!options.authenticatedClient) {
      throw new Error(
        `Contrail method ${method} requires an authenticated AT Protocol client`,
      );
    }
    const cached = tokens.get(method);
    if (!force && cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) {
      return cached.value;
    }
    if (!force) {
      const pending = pendingTokens.get(method);
      if (pending) return pending;
    }

    const pending = (async () => {
      const response = await options.authenticatedClient!.get(
        "com.atproto.server.getServiceAuth",
        {
          params: {
            aud: auth.audience as Did,
            lxm: method,
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `Could not mint service token for ${method}: ${response.status}`,
        );
      }
      const token = response.data.token;
      tokens.set(method, { value: token, expiresAt: tokenExpiration(token) });
      return token;
    })();
    pendingTokens.set(method, pending);
    try {
      return await pending;
    } finally {
      if (pendingTokens.get(method) === pending) pendingTokens.delete(method);
    }
  };

  return async (pathname, init) => {
    const method = xrpcMethod(pathname);
    if (!method) return base(pathname, init);
    // A generated lock pin is a runtime contract: verify it once even when the
    // first operation is anonymous. Unpinned clients remain challenge-driven.
    if (options.contractDigest) await discoverServiceAuth();
    if (!options.authenticatedClient) return base(pathname, init);

    // Once discovery has been loaded, avoid the initial challenge on subsequent
    // protected calls.
    if (serviceAuthPromise) {
      const auth = await protectedMethod(method);
      if (auth) {
        const token = await tokenFor(method, auth);
        const response = await base(pathname, withBearer(init, token));
        if (response.status !== 401) return response;
        await response.body?.cancel();
        tokens.delete(method);
        const refreshed = await tokenFor(method, auth, true);
        return base(pathname, withBearer(init, refreshed));
      }
    }

    const response = await base(pathname, init);
    if (response.status !== 401) return response;
    const auth = await protectedMethod(method);
    if (!auth) return response;
    await response.body?.cancel();
    const token = await tokenFor(method, auth);
    return base(pathname, withBearer(init, token));
  };
}

interface UntypedRequestOptions {
  input?: unknown;
  [key: string]: unknown;
}

interface UntypedClientResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  data: unknown;
}

type UntypedMethod = (
  name: string,
  options?: UntypedRequestOptions,
) => Promise<UntypedClientResponse>;
type UntypedCall = (
  schema: unknown,
  options?: UntypedRequestOptions,
) => Promise<UntypedClientResponse>;

const NOTIFIED_WRITE_METHODS = new Set([
  "com.atproto.repo.createRecord",
  "com.atproto.repo.putRecord",
  "com.atproto.repo.deleteRecord",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function writtenRecordUri(
  method: string,
  request: UntypedRequestOptions | undefined,
  response: UntypedClientResponse,
  collections: ReadonlySet<string>,
  resolveHandle: (handle: string) => Promise<Did>,
): Promise<string | null> {
  if (!response.ok || !NOTIFIED_WRITE_METHODS.has(method)) return null;
  const input = objectValue(request?.input);
  const collection = input?.collection;
  if (typeof collection !== "string" || !collections.has(collection)) {
    return null;
  }

  if (
    method === "com.atproto.repo.createRecord" ||
    method === "com.atproto.repo.putRecord"
  ) {
    const uri = objectValue(response.data)?.uri;
    return typeof uri === "string" ? uri : null;
  }

  const repo = input?.repo;
  const rkey = input?.rkey;
  if (typeof repo !== "string" || typeof rkey !== "string") return null;
  const did = isDid(repo) ? repo : await resolveHandle(repo);
  return `at://${did}/${collection}/${rkey}`;
}

function schemaNsid(schema: unknown): string | null {
  const namespace = objectValue(schema);
  const value = objectValue(namespace?.mainSchema) ?? namespace;
  return typeof value?.nsid === "string" ? value.nsid : null;
}

function createClient(
  options: PublicServiceClientOptions,
  authenticatedOptions: PublicServiceAuthenticatedOptions = {},
): PublicServiceClient {
  const endpoint = normalizePublicServiceEndpoint(options.endpoint, options);
  const authenticatedClients = new WeakMap<Client, PublicServiceClient>();
  const client = new Client({
    handler: publicServiceFetchHandler({ ...options, endpoint }),
  }) as PublicServiceClient;
  const expectedScope = options.serviceDid
    ? publicServiceOAuthScope(options.serviceDid)
    : null;
  if (options.scope && options.scope !== expectedScope) {
    throw new Error(
      `Contrail OAuth scope mismatch: expected ${expectedScope ?? "none"}, received ${options.scope}`,
    );
  }
  const scope = options.scope ?? expectedScope;
  const collections = Object.freeze([...(options.collections ?? [])]);

  Object.defineProperties(client, {
    endpoint: { value: endpoint, enumerable: true },
    scope: { value: scope, enumerable: true },
    collections: { value: collections, enumerable: true },
    authenticated: {
      enumerable: true,
      value(
        authenticatedClient: Client,
        childOptions: PublicServiceAuthenticatedOptions = {},
      ) {
        if (
          options.authenticatedClient === authenticatedClient &&
          !childOptions.onNotificationError
        ) {
          return client;
        }
        if (!childOptions.onNotificationError) {
          const existing = authenticatedClients.get(authenticatedClient);
          if (existing) return existing;
        }
        const created = createClient(
          { ...options, endpoint, authenticatedClient },
          childOptions,
        );
        if (!childOptions.onNotificationError) {
          authenticatedClients.set(authenticatedClient, created);
        }
        return created;
      },
    },
  });

  if (options.authenticatedClient && options.serviceMethods) {
    const serviceMethods = new Set<string>(options.serviceMethods);
    const trackedCollections = new Set<string>(collections);
    const serviceGet = client.get.bind(client) as unknown as UntypedMethod;
    const servicePost = client.post.bind(client) as unknown as UntypedMethod;
    const serviceCall = client.call.bind(client) as unknown as UntypedCall;
    const pdsGet = options.authenticatedClient.get.bind(
      options.authenticatedClient,
    ) as unknown as UntypedMethod;
    const pdsPost = options.authenticatedClient.post.bind(
      options.authenticatedClient,
    ) as unknown as UntypedMethod;
    const pdsCall = options.authenticatedClient.call.bind(
      options.authenticatedClient,
    ) as unknown as UntypedCall;

    const reportNotificationError = (
      error: unknown,
      method: string,
      uris: readonly string[],
    ) => {
      try {
        authenticatedOptions.onNotificationError?.(error, {
          method: method as Nsid,
          uris,
        });
      } catch {
        // A reporting callback must never turn a committed PDS write into a
        // failed write response.
      }
    };

    const resolveHandle = async (handle: string): Promise<Did> => {
      const response = await pdsGet("com.atproto.identity.resolveHandle", {
        params: { handle },
      });
      const did = objectValue(response.data)?.did;
      if (!response.ok || typeof did !== "string" || !isDid(did)) {
        throw new Error(`Could not resolve deleted record repo ${handle}`);
      }
      return did;
    };

    const notifyWrite = async (method: string, uri: string) => {
      if (!options.notifyMethod) return;
      try {
        const notified = await servicePost(options.notifyMethod, {
          input: { uris: [uri] },
        });
        if (!notified.ok) {
          throw new Error(
            `Contrail notification failed with status ${notified.status}`,
          );
        }
        const errors = objectValue(notified.data)?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          throw new Error(
            `Contrail notification reported errors: ${errors.join("; ")}`,
          );
        }
      } catch (error) {
        reportNotificationError(error, method, [uri]);
      }
    };

    Object.defineProperties(client, {
      get: {
        value: ((name: string, request?: UntypedRequestOptions) =>
          serviceMethods.has(name)
            ? serviceGet(name, request)
            : pdsGet(name, request)) as Client["get"],
      },
      post: {
        value: (async (name: string, request?: UntypedRequestOptions) => {
          if (serviceMethods.has(name)) return servicePost(name, request);
          const response = await pdsPost(name, request);
          if (options.notifyMethod) {
            try {
              const uri = await writtenRecordUri(
                name,
                request,
                response,
                trackedCollections,
                resolveHandle,
              );
              if (uri) await notifyWrite(name, uri);
            } catch (error) {
              reportNotificationError(error, name, []);
            }
          }
          return response;
        }) as Client["post"],
      },
      call: {
        value: ((schema: unknown, request?: UntypedRequestOptions) => {
          const method = schemaNsid(schema);
          return method && serviceMethods.has(method)
            ? serviceCall(schema, request)
            : pdsCall(schema, request);
        }) as Client["call"],
      },
    });
  }

  return client;
}

/** Create a typed Atcute client for anonymous and service-auth Contrail methods.
 *  Generated Lexicon imports still supply the method-specific TypeScript API. */
export function createPublicServiceClient(
  options: PublicServiceClientOptions & { serviceDid: Did },
): PublicServiceClient & { readonly scope: `rpc?lxm=*&aud=${string}` };
export function createPublicServiceClient(
  options: PublicServiceClientOptions,
): PublicServiceClient;
export function createPublicServiceClient(
  options: PublicServiceClientOptions,
): PublicServiceClient {
  return createClient(options);
}
