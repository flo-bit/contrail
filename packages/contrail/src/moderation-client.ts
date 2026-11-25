import type {} from "@atcute/atproto";
import type { Client } from "@atcute/client";
import {
  parseResourceUri,
  type AtprotoAudience,
  type Did,
  type Nsid,
} from "@atcute/lexicons/syntax";
import * as TID from "@atcute/tid";
import { normalizePublicServiceEndpoint } from "./public-service.js";
import { parseServiceAudience } from "./service-auth-contract.js";
import {
  MODERATION_ACTION_NSID,
  REPORT_REASON_TYPES,
  type ReportReasonType,
} from "./moderation-contract.js";

export { MODERATION_ACTION_NSID, REPORT_REASON_TYPES, type ReportReasonType };

export interface ModerationService {
  /** Trusted app configuration, never a user-supplied report destination. */
  endpoint: string;
  audience: AtprotoAudience;
  namespace: string;
  name?: string;
}

export type ReportSubject =
  | { $type: "com.atproto.admin.defs#repoRef"; did: Did }
  | { $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

export interface ModerationReport {
  id: number;
  reportedBy: string;
  subject: ReportSubject;
  reasonType: string;
  reason?: string;
  createdAt: string;
  status: "open" | "resolved";
  resolution?: string | null;
  actionUri?: string | null;
  preview?: {
    records: unknown[];
    labels: Record<string, unknown[]>;
    hidden: boolean;
  };
}

export interface ReportPage {
  reports: ModerationReport[];
  cursor?: string;
}

export class ModerationRequestError extends Error {
  constructor(
    public status: number,
    public error: string,
    message?: string,
  ) {
    super(message ?? error);
  }
}

const NAMESPACE_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)*$/;

/** Validate trusted service config before any token is minted. Loopback HTTP
 * is allowed for development only. */
function serviceEndpoint(service: ModerationService): string {
  const endpoint = normalizePublicServiceEndpoint(service.endpoint, {
    allowInsecureHttp: true,
  });
  parseServiceAudience(service.audience);
  if (!NAMESPACE_PATTERN.test(service.namespace)) {
    throw new TypeError("moderation service namespace must be an NSID prefix");
  }
  return endpoint;
}

/** Granular `rpc` permissions for OAuth client metadata. Pass `moderator` for
 * inbox access. Existing sessions must reauthorize to receive them. */
export function moderationOAuthScope(
  service: ModerationService,
  moderator = false,
): string {
  serviceEndpoint(service);
  const methods = [
    "com.atproto.moderation.createReport",
    ...(moderator
      ? [
          `${service.namespace}.moderation.listReports`,
          `${service.namespace}.moderation.resolveReport`,
        ]
      : []),
  ];
  return methods
    .map(
      (method) =>
        `rpc?lxm=${encodeURIComponent(method)}&aud=${encodeURIComponent(service.audience)}`,
    )
    .join(" ");
}

async function call<T>(
  client: Client,
  service: ModerationService,
  method: string,
  options: {
    input?: unknown;
    params?: Record<string, string | number>;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
  } = {},
): Promise<T> {
  const endpoint = serviceEndpoint(service);
  // getServiceAuth's older generated Lexicon types still call aud a DID.
  // Preserve the FULL fragmented audience on the wire; never strip #service.
  const token = await client.get("com.atproto.server.getServiceAuth", {
    params: { aud: service.audience as unknown as Did, lxm: method as Nsid },
    signal: options.signal,
  });
  if (!token.ok) {
    throw new ModerationRequestError(
      token.status,
      token.data.error,
      token.data.message,
    );
  }
  const url = new URL(`/xrpc/${method}`, endpoint);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  // Only the method-bound service JWT is sent, never the OAuth bearer, and
  // redirects are refused so it cannot be forwarded elsewhere. Cookie and
  // cache options only matter in browsers; some server runtimes reject them.
  const browserOnly = "document" in globalThis
    ? { credentials: "omit", cache: "no-store" }
    : {};
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    ...(browserOnly as RequestInit),
    method: options.input === undefined ? "GET" : "POST",
    // workerd supports manual/follow only; manual also protects browser JWTs.
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token.data.token}`,
      ...(options.input === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.input === undefined
      ? {}
      : { body: JSON.stringify(options.input) }),
    signal: options.signal,
  });
  // Browsers expose manual cross-origin redirects as opaque responses (not
  // included in workerd's Response.type typings). Reject before parsing:
  // redirect bodies may be HTML or unreadable.
  if (
    (response.type as string) === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new ModerationRequestError(
      response.status,
      "RedirectNotAllowed",
      "Moderation service redirects are not allowed",
    );
  }
  const body = await response.json();
  if (!response.ok) {
    const failure = body as { error?: string; message?: string };
    throw new ModerationRequestError(
      response.status,
      failure.error ?? "RequestFailed",
      failure.message,
    );
  }
  return body as T;
}

/** Pass the authenticated atcute Client from your server or browser OAuth
 * session. The helper mints a method-bound service JWT, not an OAuth bearer. */
export function submitReport(options: {
  client: Client;
  service: ModerationService;
  subject: ReportSubject;
  reasonType: ReportReasonType;
  reason?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}) {
  return call<{ id: number; createdAt: string }>(
    options.client,
    options.service,
    "com.atproto.moderation.createReport",
    {
      input: {
        subject: options.subject,
        reasonType: options.reasonType,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      signal: options.signal,
      fetch: options.fetch,
    },
  );
}

export function listReports(options: {
  client: Client;
  service: ModerationService;
  status?: "open" | "resolved";
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}) {
  return call<ReportPage>(
    options.client,
    options.service,
    `${options.service.namespace}.moderation.listReports`,
    {
      params: {
        status: options.status ?? "open",
        limit: options.limit ?? 50,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
      signal: options.signal,
      fetch: options.fetch,
    },
  );
}

export function resolveReport(options: {
  client: Client;
  service: ModerationService;
  id: number;
  resolution?: string;
  actionUri?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}) {
  return call<object>(
    options.client,
    options.service,
    `${options.service.namespace}.moderation.resolveReport`,
    {
      input: {
        id: options.id,
        ...(options.resolution === undefined
          ? {}
          : { resolution: options.resolution }),
        ...(options.actionUri === undefined
          ? {}
          : { actionUri: options.actionUri }),
      },
      signal: options.signal,
      fetch: options.fetch,
    },
  );
}

/** Deliberately whitelist public fields. Private report reasons/notes can
 * never be copied into a moderator's public repository by object spreading. */
export async function createModerationAction(options: {
  client: Client;
  did: Did;
  subject: string;
  action: string;
  subjectCid?: string;
  expiresAt?: string;
}) {
  if (
    !options.subject.startsWith("did:") &&
    !options.subject.startsWith("at://did:")
  ) {
    throw new TypeError("Expected a DID or DID-authority record URI");
  }
  const result = await options.client.post("com.atproto.repo.createRecord", {
    input: {
      repo: options.did,
      collection: MODERATION_ACTION_NSID,
      rkey: TID.now(),
      record: {
        $type: MODERATION_ACTION_NSID,
        subject: options.subject,
        action: options.action,
        ...(options.subjectCid ? { subjectCid: options.subjectCid } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        createdAt: new Date().toISOString(),
      },
    },
  });
  if (!result.ok) {
    throw new ModerationRequestError(
      result.status,
      result.data.error,
      result.data.message,
    );
  }
  return result.data;
}

export async function deleteModerationAction(options: {
  client: Client;
  did: Did;
  uri: string;
}) {
  const parsed = parseResourceUri(options.uri);
  if (
    parsed.repo !== options.did ||
    parsed.collection !== MODERATION_ACTION_NSID ||
    !parsed.rkey
  ) {
    throw new TypeError("Can only undo action records in your own repository");
  }
  const result = await options.client.post("com.atproto.repo.deleteRecord", {
    input: {
      repo: options.did,
      collection: MODERATION_ACTION_NSID,
      rkey: parsed.rkey,
    },
  });
  if (!result.ok) {
    throw new ModerationRequestError(
      result.status,
      result.data.error,
      result.data.message,
    );
  }
}
