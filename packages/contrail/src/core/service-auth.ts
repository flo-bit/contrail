import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";
import type {
  AtprotoAudience,
  AtprotoDid,
  Nsid,
} from "@atcute/lexicons/syntax";
import { ServiceJwtVerifier, type VerifiedJwt } from "@atcute/xrpc-server/auth";
import { XRPCError } from "@atcute/xrpc-server";
import { parseServiceAudience } from "../service-auth-contract.js";
import type { AtprotoServiceAuthMethod, ContrailConfig } from "./types.js";

const AUTH_TIMEOUT_MS = 5_000;
const DID_CACHE_TTL_MS = 5 * 60_000;
const DID_CACHE_MAX = 1_000;

type DidDocument = Awaited<ReturnType<DidDocumentResolver["resolve"]>>;

/** Add bounded success caching and in-flight deduplication while preserving the
 * resolver's `noCache` escape hatch for signing-key rotation retries. */
export function createCachedDidDocumentResolver(
  resolver: DidDocumentResolver,
  options: { ttlMs?: number; maxEntries?: number } = {},
): DidDocumentResolver {
  const ttlMs = options.ttlMs ?? DID_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? DID_CACHE_MAX;
  const cache = new Map<string, { value: DidDocument; expiresAt: number }>();
  const pending = new Map<string, Promise<DidDocument>>();

  const remember = (did: string, value: DidDocument) => {
    cache.delete(did);
    cache.set(did, { value, expiresAt: Date.now() + ttlMs });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    async resolve(did, resolveOptions) {
      const key = String(did);
      if (!resolveOptions?.noCache) {
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          cache.delete(key);
          cache.set(key, cached);
          return cached.value;
        }
        if (cached) cache.delete(key);
        const inflight = pending.get(key);
        if (inflight) return inflight;
      }

      const request = resolver.resolve(did, resolveOptions);
      if (!resolveOptions?.noCache) pending.set(key, request);
      try {
        const value = await request;
        remember(key, value);
        return value;
      } finally {
        if (pending.get(key) === request) pending.delete(key);
      }
    },
  };
}

export interface ServiceAuthResult {
  principal?: VerifiedJwt;
  response?: Response;
}

export interface ServiceAuthGate {
  readonly serviceDid: AtprotoDid;
  readonly audience: AtprotoAudience;
  protects(method: AtprotoServiceAuthMethod): boolean;
  authorize(request: Request, method: Nsid): Promise<ServiceAuthResult>;
}

const DEFAULT_RESOLVER = createCachedDidDocumentResolver(
  new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  }),
);

function defaultResolver(): DidDocumentResolver {
  return DEFAULT_RESOLVER;
}

/** Create the shared verifier used by protected built-in routes. Tokens remain
 * bound to the exact service audience and XRPC method. */
export function createServiceAuthGate(
  config: ContrailConfig,
): ServiceAuthGate | null {
  if (!config.serviceAuth) return null;
  const serviceAuth = config.serviceAuth;
  const protectedMethods = new Set(serviceAuth.methods);
  const { serviceDid, audience } = parseServiceAudience(serviceAuth.audience);
  const verifier = new ServiceJwtVerifier({
    acceptAudiences: [audience],
    resolver: serviceAuth.resolver ?? defaultResolver(),
    maxAge: serviceAuth.maxTokenAgeSeconds,
  });

  return {
    serviceDid,
    audience,
    protects(method) {
      return protectedMethods.has(method);
    },
    async authorize(request, method) {
      try {
        const principal = await verifier.verifyRequest(request, {
          lxm: method,
          signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
        });
        return { principal };
      } catch (error) {
        if (error instanceof XRPCError) return { response: error.toResponse() };
        throw error;
      }
    },
  };
}
