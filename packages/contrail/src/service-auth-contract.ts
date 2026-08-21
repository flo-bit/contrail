import { isAtprotoAudience } from "@atcute/identity";
import type {
  AtprotoAudience,
  AtprotoDid,
  Nsid,
} from "@atcute/lexicons/syntax";
import { isNsid } from "@atcute/lexicons/syntax";
import { scope } from "@atcute/oauth-types";

export type ServiceOAuthScope = `rpc?${string}`;

export interface ParsedServiceAudience {
  audience: AtprotoAudience;
  serviceDid: AtprotoDid;
  fragment: string;
}

export interface ParsedServiceOAuthScope extends ParsedServiceAudience {
  methods: Nsid[];
  canonicalScope: ServiceOAuthScope;
}

/** Parse the exact fragmented AT Protocol audience used by OAuth and service JWTs. */
export function parseServiceAudience(value: unknown): ParsedServiceAudience {
  if (typeof value !== "string") {
    throw new TypeError(
      "service audience must be an absolute AT Protocol DID service reference",
    );
  }

  const separator = value.indexOf("#");
  if (separator === -1) {
    throw new TypeError(
      "service audience must include a non-empty service fragment",
    );
  }
  if (separator === value.length - 1) {
    throw new TypeError("service audience fragment must not be empty");
  }
  if (value.indexOf("#", separator + 1) !== -1) {
    throw new TypeError("service audience must contain exactly one fragment");
  }
  if (!isAtprotoAudience(value)) {
    throw new TypeError(
      "service audience must use a supported did:plc or did:web service reference",
    );
  }

  return {
    audience: value,
    serviceDid: value.slice(0, separator) as AtprotoDid,
    fragment: value.slice(separator + 1),
  };
}

/** Canonical ordering for every contract field. Code-unit order is identical in
 * every runtime, while `localeCompare` varies with the host locale and ICU
 * build — and these orderings are compared byte for byte across processes. */
export function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeMethods(values: readonly string[]): Nsid[] {
  if (!Array.isArray(values)) {
    throw new TypeError("service OAuth scope methods must be an array");
  }

  const methods = new Set<Nsid>();
  for (const value of values) {
    if (!isNsid(value)) {
      throw new TypeError(
        `service OAuth scope method must be a valid NSID: ${String(value)}`,
      );
    }
    methods.add(value);
  }
  if (methods.size === 0) {
    throw new TypeError("service OAuth scope requires at least one method");
  }
  return [...methods].sort(compareCanonical);
}

/** Format one deterministic least-privilege RPC permission for a service. */
export function formatServiceOAuthScope(
  audience: AtprotoAudience,
  methodNsids: readonly string[],
): ServiceOAuthScope {
  const parsed = parseServiceAudience(audience);
  const methods = normalizeMethods(methodNsids);
  return scope.rpc({ aud: parsed.audience, lxm: methods }) as ServiceOAuthScope;
}

function decodeScopeValue(value: string): string {
  try {
    // Scope query values use percent encoding, not form encoding: preserve '+'.
    return decodeURIComponent(value);
  } catch {
    throw new TypeError("service OAuth scope contains invalid percent encoding");
  }
}

/** Parse and semantically normalize the limited exact RPC scope Contrail uses. */
export function parseServiceOAuthScope(
  value: unknown,
): ParsedServiceOAuthScope {
  if (typeof value !== "string" || !value.startsWith("rpc?")) {
    throw new TypeError("service OAuth scope must be an rpc permission");
  }

  const query = value.slice(4);
  if (!query) {
    throw new TypeError("service OAuth scope must contain parameters");
  }

  const audiences: string[] = [];
  const rawMethods: string[] = [];
  for (const part of query.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) {
      throw new TypeError("service OAuth scope contains an empty parameter");
    }

    const name = part.slice(0, separator);
    const rawValue = part.slice(separator + 1);
    if (name !== "aud" && name !== "lxm") {
      throw new TypeError(`unsupported service OAuth scope parameter: ${name}`);
    }
    if (name === "aud" && rawValue.includes("#")) {
      throw new TypeError(
        "service OAuth scope audience fragment must be percent-encoded",
      );
    }

    const decoded = decodeScopeValue(rawValue);
    if (name === "aud") audiences.push(decoded);
    else rawMethods.push(decoded);
  }

  if (audiences.length !== 1) {
    throw new TypeError(
      "service OAuth scope must contain exactly one audience",
    );
  }

  const parsed = parseServiceAudience(audiences[0]);
  const methods = normalizeMethods(rawMethods);
  return {
    ...parsed,
    methods,
    canonicalScope: formatServiceOAuthScope(parsed.audience, methods),
  };
}
