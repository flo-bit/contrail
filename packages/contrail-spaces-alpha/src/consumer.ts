import { formatServiceOAuthScope } from "@atmo-dev/contrail";
import {
  formatSpaceRecordUri,
  formatSpaceUri,
  parseSpaceUri,
} from "./uri";

export interface AuthenticatedPdsSession {
  did: string;
  handle(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface SpacePermissionScopeInput {
  type: string;
  authority?: string;
  skey?: string;
  collections: readonly string[];
  actions?: readonly ("read" | "create" | "update" | "delete")[];
  manage?: readonly ("create" | "update" | "delete")[];
}

/** Build the current alpha permission token without requiring consumer apps to
 * install the alpha scope parser alongside @svelte-atproto/oauth. */
export function formatSpacePermissionScope(input: SpacePermissionScopeInput): string {
  const params = new URLSearchParams();
  params.set("authority", input.authority ?? "*");
  if (input.skey) params.set("skey", input.skey);
  for (const collection of input.collections) params.append("collection", collection);
  for (const action of input.actions ?? ["read", "create", "update", "delete"]) {
    params.append("action", action);
  }
  for (const manage of input.manage ?? ["create", "update", "delete"]) {
    params.append("manage", manage);
  }
  return `space:${input.type}?${params.toString()}`;
}

export function spacesConsumerOAuthScopes(input: {
  audience: string;
  namespace: string;
  collections: readonly string[];
  spaceType: string;
  skey?: string;
}): string[] {
  const methods = [
    `${input.namespace}.authorizeSpace`,
    `${input.namespace}.syncSpace`,
    ...input.collections.flatMap((collection) => {
      const short = collection.split(".").at(-1)!;
      return [
        `${input.namespace}.${short}.listSpaceRecords`,
        `${input.namespace}.${short}.getSpaceRecord`,
      ];
    }),
  ];
  return [
    "atproto",
    formatSpacePermissionScope({
      type: input.spaceType,
      skey: input.skey,
      collections: input.collections,
    }),
    formatServiceOAuthScope(input.audience as never, methods),
  ];
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const object = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const code = typeof object.error === "string" ? object.error : `HTTP${response.status}`;
    const message = typeof object.message === "string" ? object.message : code;
    throw new Error(message);
  }
  return body as T;
}

async function pdsQuery<T>(
  session: AuthenticatedPdsSession,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await session.handle(`/xrpc/${method}?${query}`, {
    headers: { accept: "application/json" },
  });
  return readJson<T>(response);
}

async function pdsProcedure<T>(
  session: AuthenticatedPdsSession,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await session.handle(`/xrpc/${method}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<T>(response);
}

export function createSpace(
  session: AuthenticatedPdsSession,
  input: {
    type: string;
    skey?: string;
    managingApp: string;
  },
): Promise<{ uri: string }> {
  return pdsProcedure(session, "com.atproto.simplespace.createSpace", {
    type: input.type,
    ...(input.skey ? { skey: input.skey } : {}),
    policy: {
      $type: "com.atproto.simplespace.defs#managingAppPolicy",
      managingApp: input.managingApp,
    },
    appAccess: { $type: "com.atproto.simplespace.defs#open" },
  });
}

export function createSpaceRecord(
  session: AuthenticatedPdsSession,
  input: {
    space: string;
    collection: string;
    record: Record<string, unknown>;
    rkey?: string;
  },
): Promise<{ uri: string; cid: string }> {
  parseSpaceUri(input.space);
  return pdsProcedure(session, "com.atproto.space.createRecord", {
    space: input.space,
    repo: session.did,
    collection: input.collection,
    ...(input.rkey ? { rkey: input.rkey } : {}),
    validate: false,
    record: input.record,
  });
}

export function deleteSpaceRecord(
  session: AuthenticatedPdsSession,
  input: { space: string; collection: string; rkey: string },
): Promise<Record<string, never>> {
  return pdsProcedure(session, "com.atproto.space.deleteRecord", {
    space: input.space,
    repo: session.did,
    collection: input.collection,
    rkey: input.rkey,
  });
}

export async function getDelegationToken(
  session: AuthenticatedPdsSession,
  space: string,
): Promise<string> {
  parseSpaceUri(space);
  const result = await pdsQuery<{ token: string }>(
    session,
    "com.atproto.space.getDelegationToken",
    { space },
  );
  if (!result.token) throw new Error("PDS returned no delegation token");
  return result.token;
}

export async function getServiceAuthToken(
  session: AuthenticatedPdsSession,
  input: { audience: string; method: string },
): Promise<string> {
  const result = await pdsQuery<{ token: string }>(
    session,
    "com.atproto.server.getServiceAuth",
    { aud: input.audience, lxm: input.method },
  );
  if (!result.token) throw new Error("PDS returned no service-auth token");
  return result.token;
}

export interface SpacesProviderClientOptions {
  endpoint: string;
  audience: string;
  namespace: string;
  session: AuthenticatedPdsSession;
  fetch?: typeof globalThis.fetch;
}

export class SpacesProviderClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(readonly options: SpacesProviderClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async call<T>(
    method: string,
    init: RequestInit & { params?: URLSearchParams },
  ): Promise<T> {
    const token = await getServiceAuthToken(this.options.session, {
      audience: this.options.audience,
      method,
    });
    const url = new URL(`/xrpc/${method}`, this.options.endpoint);
    if (init.params) url.search = init.params.toString();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(url, { ...init, headers });
    return readJson<T>(response);
  }

  async authorizeSpace(
    space: string,
    options: { rediscover?: boolean } = {},
  ): Promise<{ space: string; generation: number; accessExpiresAt: string }> {
    const delegation = await getDelegationToken(this.options.session, space);
    return this.call(`${this.options.namespace}.authorizeSpace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space, delegation, rediscover: options.rediscover }),
    });
  }

  syncSpace(space: string, repo?: string): Promise<{ queued: boolean }> {
    return this.call(`${this.options.namespace}.syncSpace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space, repo }),
    });
  }

  listSpaceRecords<T = Record<string, unknown>>(input: {
    space: string;
    collection: string;
    limit?: number;
    cursor?: string;
    search?: string;
    did?: string;
    filters?: Record<string, string>;
  }): Promise<{
    records: T[];
    cursor?: string;
    references: Record<string, Record<string, unknown>>;
  }> {
    const short = input.collection.split(".").at(-1)!;
    const params = new URLSearchParams({ space: input.space });
    if (input.limit) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.search) params.set("search", input.search);
    if (input.did) params.set("did", input.did);
    for (const [key, value] of Object.entries(input.filters ?? {})) {
      params.set(key, value);
    }
    return this.call(
      `${this.options.namespace}.${short}.listSpaceRecords`,
      { method: "GET", params },
    );
  }

  getSpaceRecord<T = Record<string, unknown>>(input: {
    space: string;
    collection: string;
    uri: string;
  }): Promise<{ record: T; references: Record<string, Record<string, unknown>> }> {
    const short = input.collection.split(".").at(-1)!;
    const params = new URLSearchParams({ space: input.space, uri: input.uri });
    return this.call(
      `${this.options.namespace}.${short}.getSpaceRecord`,
      { method: "GET", params },
    );
  }
}

export { formatSpaceRecordUri, formatSpaceUri };
