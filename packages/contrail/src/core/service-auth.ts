import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
import { ServiceJwtVerifier, type VerifiedJwt } from "@atcute/xrpc-server/auth";
import { XRPCError } from "@atcute/xrpc-server";
import type { AtprotoServiceAuthMethod, ContrailConfig } from "./types.js";

const AUTH_TIMEOUT_MS = 5_000;

export interface ServiceAuthResult {
  principal?: VerifiedJwt;
  response?: Response;
}

export interface ServiceAuthGate {
  readonly audience: Did;
  protects(method: AtprotoServiceAuthMethod): boolean;
  authorize(request: Request, method: Nsid): Promise<ServiceAuthResult>;
}

function defaultResolver(): DidDocumentResolver {
  return new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  });
}

/** Create the shared verifier used by protected built-in routes. Tokens remain
 * method-bound even when a client obtained permission through one wildcard
 * OAuth scope (`rpc?lxm=*&aud=<service-did>`). */
export function createServiceAuthGate(
  config: ContrailConfig,
): ServiceAuthGate | null {
  if (!config.serviceAuth) return null;
  const serviceAuth = config.serviceAuth;
  const protectedMethods = new Set(serviceAuth.methods);
  const audience = serviceAuth.audience as Did;
  const verifier = new ServiceJwtVerifier({
    acceptAudiences: [audience],
    resolver: serviceAuth.resolver ?? defaultResolver(),
    maxAge: serviceAuth.maxTokenAgeSeconds,
  });

  return {
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
