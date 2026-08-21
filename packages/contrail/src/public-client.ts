import type {} from "@atcute/atproto";
import {
  Client,
  simpleFetchHandler,
  type FetchHandler,
} from "@atcute/client";
import {
  isDid,
  type AtprotoAudience,
  type AtprotoDid,
  type Did,
  type Nsid,
} from "@atcute/lexicons/syntax";
import {
  isPublicServiceManifest,
  normalizePublicServiceEndpoint,
  type PublicServiceAuthContract,
} from "./public-service.js";
import {
  compareCanonical,
  formatServiceOAuthScope,
  parseServiceAudience,
  parseServiceOAuthScope,
  type ServiceOAuthScope,
} from "./service-auth-contract.js";

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
  /** Base receiving-service DID from the verified provider contract. Null and
   *  an omitted value both mean the provider serves no protected methods. */
  serviceDid?: AtprotoDid | null;
  /** Exact fragmented OAuth and JWT audience from the provider contract. */
  serviceAudience?: AtprotoAudience | null;
  /** Exact least-privilege OAuth permission from the provider contract. */
  scope?: ServiceOAuthScope | null;
  /** XRPC methods granted by the exact OAuth permission. */
  protectedMethods?: readonly Nsid[] | null;
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
  readonly scope: ServiceOAuthScope | null;
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
  audience: AtprotoAudience,
  protectedMethods: readonly Nsid[],
): ServiceOAuthScope {
  return formatServiceOAuthScope(audience, protectedMethods);
}

interface ConfiguredServiceAuth {
  serviceDid: AtprotoDid;
  audience: AtprotoAudience;
  scope: ServiceOAuthScope;
  protectedMethods: Nsid[];
}

function sameMethods(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((method, index) => method === right[index])
  );
}

function configuredServiceAuth(
  options: PublicServiceClientOptions,
): ConfiguredServiceAuth | null {
  // A provider without protected methods is generated as absent keys, but the
  // untyped `lex.config.js` block spells the same thing as nulls and an empty
  // method list. Both mean anonymous-only, never a half-configured contract.
  const absent = (value: unknown) =>
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0);
  const supplied = [
    options.serviceDid,
    options.serviceAudience,
    options.scope,
    options.protectedMethods,
  ];
  if (supplied.every(absent)) return null;
  if (supplied.some(absent)) {
    throw new Error(
      "Contrail service auth configuration is incomplete; run `contrail connect --update` and reauthorize",
    );
  }

  try {
    const audience = parseServiceAudience(options.serviceAudience);
    const parsedScope = parseServiceOAuthScope(options.scope);
    const canonicalScope = formatServiceOAuthScope(
      audience.audience,
      options.protectedMethods!,
    );
    if (options.serviceDid !== audience.serviceDid) {
      throw new Error(
        `service DID ${options.serviceDid} does not match audience ${audience.audience}`,
      );
    }
    if (parsedScope.audience !== audience.audience) {
      throw new Error("OAuth scope targets a different service audience");
    }
    if (parsedScope.canonicalScope !== canonicalScope) {
      throw new Error("OAuth scope does not grant the exact protected methods");
    }
    return {
      serviceDid: audience.serviceDid,
      audience: audience.audience,
      scope: canonicalScope,
      protectedMethods: parsedScope.methods,
    };
  } catch (error) {
    throw new Error(
      `Contrail service auth configuration is invalid; run \`contrail connect --update\` and reauthorize: ${(error as Error).message}`,
    );
  }
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

/** Fetch handler that keeps anonymous reads direct while automatically
 * discovering service auth and minting, caching, and attaching method-bound AT
 * Protocol service tokens after a protected route challenges the first request. */
export function publicServiceFetchHandler(
  options: PublicServiceClientOptions,
): FetchHandler {
  const endpoint = normalizePublicServiceEndpoint(options.endpoint, options);
  const configuredAuth = configuredServiceAuth(options);
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
      const serviceAuth = value.serviceAuth ?? null;
      if (!serviceAuth) {
        if (configuredAuth) {
          throw new PublicServiceContractError(
            `Contrail service DID mismatch: expected ${configuredAuth.serviceDid}, received none`,
          );
        }
        return null;
      }
      if (!configuredAuth) {
        throw new PublicServiceContractError(
          "Contrail protected methods are not configured; run `contrail connect --update` and reauthorize",
        );
      }
      if (serviceAuth.serviceDid !== configuredAuth.serviceDid) {
        throw new PublicServiceContractError(
          `Contrail service DID mismatch: expected ${configuredAuth.serviceDid}, received ${serviceAuth.serviceDid}`,
        );
      }
      if (serviceAuth.audience !== configuredAuth.audience) {
        throw new PublicServiceContractError(
          `Contrail service audience mismatch: expected ${configuredAuth.audience}, received ${serviceAuth.audience}`,
        );
      }
      if (serviceAuth.scope !== configuredAuth.scope) {
        throw new PublicServiceContractError(
          `Contrail OAuth scope mismatch: expected ${configuredAuth.scope}, received ${serviceAuth.scope}`,
        );
      }
      const discoveredMethods = serviceAuth.methods
        .map((method) => method.id)
        .sort(compareCanonical);
      if (!sameMethods(discoveredMethods, configuredAuth.protectedMethods)) {
        throw new PublicServiceContractError(
          "Contrail protected-method mismatch; run `contrail connect --update` and reauthorize",
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
            aud: auth.audience,
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
  const serviceAuth = configuredServiceAuth(options);
  const authenticatedClients = new WeakMap<Client, PublicServiceClient>();
  const client = new Client({
    handler: publicServiceFetchHandler({ ...options, endpoint }),
  }) as PublicServiceClient;
  const scope = serviceAuth?.scope ?? null;
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
  options: PublicServiceClientOptions & {
    serviceDid: AtprotoDid;
    serviceAudience: AtprotoAudience;
    scope: ServiceOAuthScope;
    protectedMethods: readonly Nsid[];
  },
): PublicServiceClient & { readonly scope: ServiceOAuthScope };
export function createPublicServiceClient(
  options: PublicServiceClientOptions,
): PublicServiceClient;
export function createPublicServiceClient(
  options: PublicServiceClientOptions,
): PublicServiceClient {
  return createClient(options);
}
