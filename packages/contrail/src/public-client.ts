import type {} from "@atcute/atproto";
import {
  Client,
  simpleFetchHandler,
  type FetchHandler,
} from "@atcute/client";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
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

export interface PublicServiceClientOptions {
  /** Canonical public Contrail HTTPS origin. */
  endpoint: string;
  /** Existing authenticated PDS client used to mint service tokens. Omit when
   *  the consumer only needs anonymous methods. */
  authenticatedPds?: Client;
  /** Optional contract pin from `contrail.lock.json`. */
  contractDigest?: string;
  /** Browser, test, or instrumented fetch implementation. */
  fetch?: typeof globalThis.fetch;
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

/** Fetch handler that keeps anonymous reads cheap while automatically minting,
 * caching, and attaching method-bound AT Protocol service tokens after a
 * protected route challenges the first request. */
export function publicServiceFetchHandler(
  options: PublicServiceClientOptions,
): FetchHandler {
  const endpoint = normalizePublicServiceEndpoint(options.endpoint);
  const fetcher = options.fetch ?? fetch;
  const base = simpleFetchHandler({ service: endpoint, fetch: fetcher });
  const tokens = new Map<string, CachedToken>();
  const pendingTokens = new Map<string, Promise<string>>();
  let serviceAuthPromise: Promise<PublicServiceAuthContract | null> | null = null;

  const discoverServiceAuth = () => {
    if (serviceAuthPromise) return serviceAuthPromise;
    serviceAuthPromise = (async () => {
      const response = await fetcher(`${endpoint}/.well-known/contrail`, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Contrail discovery failed: ${response.status}`);
      }
      if (response.url && new URL(response.url).origin !== endpoint) {
        throw new Error("Contrail discovery redirected to a different origin");
      }
      const value: unknown = await response.json();
      if (!isPublicServiceManifest(value)) {
        throw new Error("response is not a supported Contrail service manifest");
      }
      if (normalizePublicServiceEndpoint(value.endpoint) !== endpoint) {
        throw new Error("Contrail manifest endpoint mismatch");
      }
      if (
        options.contractDigest &&
        value.contract.digest !== options.contractDigest
      ) {
        throw new Error(
          `Contrail contract digest mismatch: expected ${options.contractDigest}, received ${value.contract.digest}`,
        );
      }
      return value.serviceAuth ?? null;
    })();
    return serviceAuthPromise;
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
    if (!options.authenticatedPds) {
      throw new Error(
        `Contrail method ${method} requires an authenticated PDS client`,
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
      const response = await options.authenticatedPds!.get(
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
    if (!method || !options.authenticatedPds) return base(pathname, init);

    // Once discovery has been loaded, avoid the initial challenge on subsequent
    // protected calls. Anonymous calls never wait for discovery.
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

/** Create a typed Atcute client for anonymous and service-auth Contrail methods.
 *  Generated Lexicon imports still supply the method-specific TypeScript API. */
export function createPublicServiceClient(
  options: PublicServiceClientOptions,
): Client {
  return new Client({ handler: publicServiceFetchHandler(options) });
}
