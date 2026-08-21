import {
  bindRecordValidationLexicons,
  createExactServiceAuthGate,
  prepareRecordValidation,
  queryIsolatedRecords,
  resolveConfig,
  validateConfig,
  type ContrailConfig,
  type Database,
} from "@atmo-dev/contrail";
import { decodeJwtClaims } from "./crypto";
import {
  exchangeSpaceCredential,
  SpaceProtocolError,
} from "./protocol";
import {
  ensureSpaceWatch,
  getSpaceWatch,
  hasAccessLease,
  hideDeletedSpace,
  initSpacesStorage,
  listConnectedSpaceWatches,
  purgeSpaceGeneration,
  rediscoverSpace,
  saveAccessLease,
  saveCredential,
  updateWatch,
  type SpaceWatch,
} from "./storage";
import {
  SpacesSyncEngine,
  type SpaceTypeConfig,
} from "./sync";
import { parseSpaceUri, spaceProjectionKey } from "./uri";

export const AUTHORIZE_SPACE_METHOD = "authorizeSpace";
export const SYNC_SPACE_METHOD = "syncSpace";
export const SUBSCRIBE_SPACE_METHOD = "subscribeSpace";
export const LIST_SPACES_METHOD = "listSpaces";
export const LIST_SPACE_RECORDS_METHOD = "listSpaceRecords";
export const GET_SPACE_RECORD_METHOD = "getSpaceRecord";

export interface SpaceAuthorizationInput {
  userDid: string;
  spaceUri: string;
  action: "read" | "write";
  method: string;
}

export interface SpacesWorkerEnv {
  [key: string]: unknown;
}

export interface SpacesWorkerOptions<Env extends SpacesWorkerEnv = SpacesWorkerEnv> {
  projection: ContrailConfig;
  lexicons?: readonly object[];
  spaceTypes: Record<string, SpaceTypeConfig>;
  service: {
    endpoint: string;
    audience: string;
    /** Optional DID resolver for private networks and deterministic tests. */
    resolver?: NonNullable<ContrailConfig["serviceAuth"]>["resolver"];
  };
  bindings?: {
    database?: string;
    credentialEncryptionKey?: string;
    queue?: string;
  };
  authorization?: {
    authorize(
      input: SpaceAuthorizationInput,
      context: { env: Env; db: Database },
    ): boolean | Promise<boolean>;
    /** Optional inverse lookup for custom managing-app policies. Native PDS
     * policies are listed from successful provider authorization leases. */
    listSpaces?(
      userDid: string,
      context: { env: Env; db: Database },
    ): readonly string[] | Promise<readonly string[]>;
  };
  accessLeaseMs?: number;
  reconcileIntervalMs?: number;
  maxAtomicMutations?: number;
  maxRepoCarBytes?: number;
  protocol?: {
    plcUrl?: string;
    additionalAllowedHosts?: string[];
    fetch?: typeof globalThis.fetch;
  };
  /** Optional Cloudflare Durable Object fan-out for browser invalidations. */
  subscriptions?: {
    binding?: string;
    ticketTtlMs?: number;
  };
  onInvalidate?: (spaceUri: string, env: Env) => void | Promise<void>;
}

type SyncMessage =
  | { kind: "reconcile"; space: string; preferredRepo?: string }
  | { kind: "repo"; space: string; repo: string; rev?: string; hash?: string };

function json(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function privateJson(value: unknown, status = 200): Response {
  return json(value, status, { "cache-control": "private, no-store" });
}

interface SubscriptionTicket {
  expiresAt: number;
}

/** Hibernating Cloudflare WebSocket fan-out, keyed by Space URI through its
 * Durable Object ID. Tickets are issued only by the authenticated Worker XRPC
 * route and consumed once during the browser upgrade. */
export class SpaceSubscriptionHub {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/issue") {
      const body = await request.json() as { ticket?: unknown; expiresAt?: unknown };
      if (typeof body.ticket !== "string" || body.ticket.length < 16 ||
        typeof body.expiresAt !== "number" || body.expiresAt <= Date.now()) {
        return json({ error: "InvalidTicket" }, 400);
      }
      await this.state.storage.put<SubscriptionTicket>(`ticket:${body.ticket}`, {
        expiresAt: body.expiresAt,
      });
      const alarm = await this.state.storage.getAlarm();
      if (alarm === null || alarm > body.expiresAt) {
        await this.state.storage.setAlarm(body.expiresAt);
      }
      return json({ issued: true });
    }
    if (request.method === "POST" && url.pathname === "/broadcast") {
      const payload = await request.text();
      if (payload.length > 8 * 1024) return json({ error: "MessageTooLarge" }, 413);
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(payload);
        } catch {
          try {
            socket.close(1011, "Delivery failed");
          } catch {
            // The socket is already gone.
          }
        }
      }
      return json({ delivered: this.state.getWebSockets().length });
    }
    if (request.method === "GET" && url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "UpgradeRequired" }, 426);
      }
      const ticket = url.searchParams.get("ticket");
      if (!ticket) return json({ error: "InvalidTicket" }, 401);
      const key = `ticket:${ticket}`;
      const grant = await this.state.storage.get<SubscriptionTicket>(key);
      await this.state.storage.delete(key);
      if (!grant || grant.expiresAt <= Date.now()) {
        return json({ error: "InvalidTicket" }, 401);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "ready" }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "NotFound" }, 404);
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    if (message === "ping") socket.send("pong");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Workerd may already have completed the close handshake.
    }
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "WebSocket error");
    } catch {
      // The socket is already gone.
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const tickets = await this.state.storage.list<SubscriptionTicket>({
      prefix: "ticket:",
    });
    const expired: string[] = [];
    let next: number | undefined;
    for (const [key, ticket] of tickets) {
      if (ticket.expiresAt <= now) expired.push(key);
      else next = Math.min(next ?? ticket.expiresAt, ticket.expiresAt);
    }
    if (expired.length) await this.state.storage.delete(expired);
    if (next !== undefined) await this.state.storage.setAlarm(next);
  }
}

async function boundedJsonBody<T>(request: Request, maximum = 64 * 1024): Promise<T> {
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > maximum) {
    try {
      await request.body?.cancel();
    } catch {
      // The declared size is already sufficient to reject the request.
    }
    throw new TypeError("Request body is too large");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.byteLength > maximum) {
          try {
            await reader.cancel("Request body is too large");
          } catch {
            // Keep the stable request-size error if cancellation itself fails.
          }
          throw new TypeError("Request body is too large");
        }
        chunks.push(value);
        length += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof TypeError) {
    return json({ error: "InvalidRequest", message: error.message }, 400);
  }
  if (error instanceof SpaceProtocolError) {
    const status = error.code === "RepoTooLarge"
      ? 413
      : error.deleted
        ? 410
        : error.notFound
          ? 404
          : error.accessDenied || error.code === "CredentialExpired"
            ? 403
            : error.status >= 500
              ? 502
              : 400;
    return json({ error: error.code, message: error.message }, status, {
      "cache-control": "private, no-store",
    });
  }
  const message = error instanceof Error ? error.message : "Internal error";
  console.error("[spaces] request failed", error);
  return json({ error: "InternalServerError", message }, 500, {
    "cache-control": "no-store",
  });
}

function xrpcMethod(pathname: string): string | null {
  const prefix = "/xrpc/";
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
}

function collectionMethod(namespace: string, short: string, suffix: string): string {
  return `${namespace}.${short}.${suffix}`;
}

function baseDid(value: string): string {
  return value.split("#", 1)[0];
}

function validDid(value: unknown): value is string {
  return typeof value === "string" &&
    /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
}

function decodeBytes(value: unknown): Uint8Array | undefined {
  const encoded = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { $bytes?: unknown }).$bytes === "string"
      ? (value as { $bytes: string }).$bytes
      : undefined;
  if (!encoded) return undefined;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function principalDid(principal: { issuer?: unknown } | undefined): string {
  if (typeof principal?.issuer !== "string") throw new Error("Verified token has no issuer");
  return baseDid(principal.issuer);
}

function parsedRecord(row: Record<string, unknown>): Record<string, unknown> {
  const record = row.record;
  return {
    ...row,
    value: typeof record === "string" ? JSON.parse(record) : record,
    record: undefined,
  };
}

function buildProviderLexicons(config: ContrailConfig, subscriptions: boolean): object[] {
  const namespace = config.namespace;
  const recordOutput = {
    type: "object",
    required: ["records", "references"],
    properties: {
      records: { type: "array", items: { type: "unknown" } },
      cursor: { type: "string" },
      references: { type: "unknown" },
    },
  };
  return [
    {
      lexicon: 1,
      id: `${namespace}.${AUTHORIZE_SPACE_METHOD}`,
      defs: { main: {
        type: "procedure",
        input: { encoding: "application/json", schema: {
          type: "object",
          required: ["space", "delegation"],
          properties: {
            space: { type: "string", format: "uri" },
            delegation: { type: "string" },
            rediscover: { type: "boolean" },
          },
        } },
        output: { encoding: "application/json", schema: { type: "object", required: ["space", "generation", "accessExpiresAt"], properties: {
          space: { type: "string", format: "uri" },
          generation: { type: "integer", minimum: 0 },
          accessExpiresAt: { type: "string", format: "datetime" },
        } } },
      } },
    },
    {
      lexicon: 1,
      id: `${namespace}.${SYNC_SPACE_METHOD}`,
      defs: { main: {
        type: "procedure",
        input: { encoding: "application/json", schema: { type: "object", required: ["space"], properties: {
          space: { type: "string", format: "uri" },
          repo: { type: "string", format: "did" },
        } } },
        output: { encoding: "application/json", schema: { type: "object", required: ["queued"], properties: {
          queued: { type: "boolean" },
        } } },
      } },
    },
    ...(subscriptions ? [{
      lexicon: 1,
      id: `${namespace}.${SUBSCRIBE_SPACE_METHOD}`,
      defs: { main: {
        type: "procedure",
        input: { encoding: "application/json", schema: { type: "object", required: ["space"], properties: {
          space: { type: "string", format: "uri" },
        } } },
        output: { encoding: "application/json", schema: { type: "object", required: ["url", "expiresAt"], properties: {
          url: { type: "string", format: "uri" },
          expiresAt: { type: "string", format: "datetime" },
        } } },
      } },
    }] : []),
    {
      lexicon: 1,
      id: `${namespace}.${LIST_SPACES_METHOD}`,
      defs: { main: {
        type: "query",
        description: "Lists active Spaces this provider has connected for the caller; this is not global protocol membership discovery.",
        parameters: { type: "params", properties: {
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        } },
        output: { encoding: "application/json", schema: {
          type: "object",
          required: ["spaces", "truncated"],
          properties: {
            spaces: { type: "array", items: { type: "object", required: ["uri", "authorityDid", "type"], properties: {
              uri: { type: "string", format: "uri" },
              authorityDid: { type: "string", format: "did" },
              type: { type: "string", format: "nsid" },
            } } },
            cursor: { type: "string" },
            truncated: { type: "boolean" },
          },
        } },
      } },
    },
    ...Object.entries(config.collections).flatMap(([short, collection]) => {
      const parameters: Record<string, unknown> = {
        space: { type: "string", format: "uri" },
        did: { type: "string", format: "did" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string" },
        search: { type: "string" },
      };
      for (const field of Object.keys(collection.queryable ?? {})) {
        parameters[field] = { type: "string" };
        parameters[`${field}Min`] = { type: "string" };
        parameters[`${field}Max`] = { type: "string" };
      }
      return [
        {
          lexicon: 1,
          id: collectionMethod(namespace, short, LIST_SPACE_RECORDS_METHOD),
          defs: { main: {
            type: "query",
            parameters: { type: "params", required: ["space"], properties: parameters },
            output: { encoding: "application/json", schema: recordOutput },
          } },
        },
        {
          lexicon: 1,
          id: collectionMethod(namespace, short, GET_SPACE_RECORD_METHOD),
          defs: { main: {
            type: "query",
            parameters: { type: "params", required: ["space", "uri"], properties: {
              space: { type: "string", format: "uri" },
              uri: { type: "string", format: "uri" },
            } },
            output: { encoding: "application/json", schema: { type: "object", required: ["record", "references"], properties: {
              record: { type: "unknown" },
              references: { type: "unknown" },
            } } },
          } },
        },
      ];
    }),
  ];
}

function databaseFrom<Env extends SpacesWorkerEnv>(
  env: Env,
  binding: string,
): Database {
  const db = env[binding] as Database | undefined;
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error(`Missing database binding ${binding}`);
  }
  return db;
}

function stringBinding<Env extends SpacesWorkerEnv>(env: Env, binding: string): string {
  const value = env[binding];
  if (typeof value !== "string" || !value) throw new Error(`Missing secret binding ${binding}`);
  return value;
}

export function createSpacesWorker<Env extends SpacesWorkerEnv = SpacesWorkerEnv>(
  options: SpacesWorkerOptions<Env>,
): ExportedHandler<Env, SyncMessage> {
  const projection = resolveConfig(options.projection);
  validateConfig(projection);
  if (options.accessLeaseMs !== undefined &&
    (!Number.isSafeInteger(options.accessLeaseMs) || options.accessLeaseMs < 1)) {
    throw new TypeError("accessLeaseMs must be a positive integer");
  }
  if (options.reconcileIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.reconcileIntervalMs) ||
      options.reconcileIntervalMs < 1)) {
    throw new TypeError("reconcileIntervalMs must be a positive integer");
  }
  if (options.maxAtomicMutations !== undefined &&
    (!Number.isSafeInteger(options.maxAtomicMutations) ||
      options.maxAtomicMutations < 1 || options.maxAtomicMutations > 50)) {
    throw new TypeError("maxAtomicMutations must be an integer from 1 through 50");
  }
  if (options.maxRepoCarBytes !== undefined &&
    (!Number.isSafeInteger(options.maxRepoCarBytes) || options.maxRepoCarBytes < 1)) {
    throw new TypeError("maxRepoCarBytes must be a positive integer");
  }
  if (options.subscriptions?.ticketTtlMs !== undefined &&
    (!Number.isSafeInteger(options.subscriptions.ticketTtlMs) ||
      options.subscriptions.ticketTtlMs < 1_000 ||
      options.subscriptions.ticketTtlMs > 5 * 60_000)) {
    throw new TypeError("subscription ticketTtlMs must be from 1000 through 300000");
  }
  if (!options.lexicons?.length) {
    throw new TypeError("Spaces providers require a pinned runtime Lexicon bundle");
  }
  bindRecordValidationLexicons(projection, options.lexicons);
  prepareRecordValidation(projection);
  const managingAppEnabled = Object.values(options.spaceTypes).some(
    (type) => (type.policy ?? "managing-app") === "managing-app",
  );
  if (managingAppEnabled && !options.authorization) {
    throw new TypeError("Managing-app Space types require an authoritative authorizer");
  }
  for (const [spaceType, type] of Object.entries(options.spaceTypes)) {
    for (const nsid of type.collections) {
      const collection = Object.values(projection.collections).find(
        (candidate) => candidate.collection === nsid,
      );
      if (!collection) {
        throw new TypeError(`Space type ${spaceType} allows unknown collection ${nsid}`);
      }
      if (collection.validate !== true) {
        throw new TypeError(
          `Space collection ${nsid} must enable Lexicon and CID validation`,
        );
      }
    }
  }
  const namespace = projection.namespace;
  const dbBinding = options.bindings?.database ?? "DB";
  const encryptionBinding =
    options.bindings?.credentialEncryptionKey ?? "SPACES_CREDENTIAL_ENCRYPTION_KEY";
  const queueBinding = options.bindings?.queue ?? "SPACES_QUEUE";
  const subscriptionsEnabled = options.subscriptions !== undefined;
  const subscriptionBinding = options.subscriptions?.binding ?? "SPACE_SUBSCRIPTIONS";
  const subscriptionTicketTtlMs = options.subscriptions?.ticketTtlMs ?? 30_000;
  const providerLexicons = buildProviderLexicons(projection, subscriptionsEnabled);
  const exactMethods = [
    `${namespace}.${AUTHORIZE_SPACE_METHOD}`,
    `${namespace}.${SYNC_SPACE_METHOD}`,
    `${namespace}.${LIST_SPACES_METHOD}`,
    ...(subscriptionsEnabled ? [`${namespace}.${SUBSCRIBE_SPACE_METHOD}`] : []),
    "com.atproto.space.notifyWrite",
    "com.atproto.space.notifySpaceDeleted",
    ...(managingAppEnabled ? ["com.atproto.simplespace.checkUserAccess"] : []),
    ...Object.keys(projection.collections).flatMap((short) => [
      collectionMethod(namespace, short, LIST_SPACE_RECORDS_METHOD),
      collectionMethod(namespace, short, GET_SPACE_RECORD_METHOD),
    ]),
  ];
  const auth = createExactServiceAuthGate({
    audience: options.service.audience as never,
    methods: exactMethods as never,
    maxTokenAgeSeconds: 300,
    resolver: options.service.resolver,
  });
  const initialized = new WeakMap<object, Promise<void>>();

  const subscriptionHub = (env: Env, spaceUri: string): DurableObjectStub => {
    const binding = env[subscriptionBinding] as DurableObjectNamespace | undefined;
    if (!binding || typeof binding.idFromName !== "function" ||
      typeof binding.get !== "function") {
      throw new Error(`Missing Durable Object binding ${subscriptionBinding}`);
    }
    return binding.get(binding.idFromName(spaceUri));
  };

  const invalidate = async (spaceUri: string, env: Env): Promise<void> => {
    if (subscriptionsEnabled) {
      try {
        const response = await subscriptionHub(env, spaceUri).fetch(
          new Request("https://subscriptions.internal/broadcast", {
            method: "POST",
            body: JSON.stringify({
              type: "invalidate",
              space: spaceUri,
              at: new Date().toISOString(),
            }),
          }),
        );
        if (!response.ok) {
          console.warn(`[spaces] subscription broadcast failed (${response.status})`);
        }
      } catch (error) {
        // Projection commits must not roll back or be retried because a live
        // browser invalidation could not be delivered.
        console.warn("[spaces] subscription broadcast failed", error);
      }
    }
    await options.onInvalidate?.(spaceUri, env);
  };

  const runtime = (env: Env) => {
    const db = databaseFrom(env, dbBinding);
    let init = initialized.get(db as object);
    if (!init) {
      init = initSpacesStorage(db, projection);
      initialized.set(db as object, init);
    }
    const engine = new SpacesSyncEngine(db, {
      projection,
      spaceTypes: options.spaceTypes,
      serviceAudience: options.service.audience,
      credentialEncryptionKey: stringBinding(env, encryptionBinding),
      reconcileIntervalMs: options.reconcileIntervalMs,
      maxAtomicMutations: options.maxAtomicMutations,
      maxRepoCarBytes: options.maxRepoCarBytes,
      protocol: options.protocol,
      onInvalidate: subscriptionsEnabled || options.onInvalidate
        ? (space) => invalidate(space, env)
        : undefined,
    });
    return { db, init, engine };
  };

  const authorizeRequest = async (request: Request, method: string) => {
    const result = await auth.authorize(request, method as never);
    if (result.response) return { response: result.response };
    return { did: principalDid(result.principal) };
  };

  const enqueue = async (
    env: Env,
    ctx: ExecutionContext,
    message: SyncMessage,
    fallback: () => Promise<void>,
  ) => {
    const queue = env[queueBinding] as { send?: (body: SyncMessage) => Promise<void> } | undefined;
    if (queue?.send) await queue.send(message);
    else ctx.waitUntil(fallback());
  };

  const accessAllowed = async (
    env: Env,
    db: Database,
    watch: SpaceWatch,
    input: SpaceAuthorizationInput,
  ): Promise<boolean> => {
    if (input.userDid === watch.authorityDid) return true;
    const policy = options.spaceTypes[watch.spaceType]?.policy ?? "managing-app";
    if (policy === "managing-app") {
      return options.authorization!.authorize(input, { env, db });
    }
    return hasAccessLease(db, {
      userDid: input.userDid,
      spaceUri: input.spaceUri,
      generation: watch.generation,
    });
  };

  const handle = async (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (url.href.length > 16 * 1024) return json({ error: "RequestUriTooLong" }, 414);
    if (subscriptionsEnabled && url.pathname === "/subscribe" && request.method === "GET") {
      try {
        const parsed = parseSpaceUri(url.searchParams.get("space"));
        const ticket = url.searchParams.get("ticket");
        if (!ticket || !/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) {
          return json({ error: "InvalidTicket" }, 401);
        }
        const internal = new URL("https://subscriptions.internal/connect");
        internal.searchParams.set("ticket", ticket);
        return subscriptionHub(env, parsed.uri).fetch(new Request(internal, {
          method: "GET",
          headers: request.headers,
        }));
      } catch {
        return json({ error: "InvalidSubscription" }, 400);
      }
    }
    if (url.pathname === "/.well-known/did.json" && request.method === "GET") {
      return json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: auth.serviceDid,
        service: [{
          id: options.service.audience,
          type: "AtprotoSpaceService",
          serviceEndpoint: options.service.endpoint,
        }],
      });
    }
    if (url.pathname === "/lexicons" && request.method === "GET") {
      return json(providerLexicons, 200, {
        "cache-control": "public, max-age=300",
      });
    }
    if (
      url.pathname === "/.well-known/contrail-spaces-alpha" &&
      request.method === "GET"
    ) {
      return json({
        version: 1,
        status: "experimental",
        serviceDid: auth.serviceDid,
        audience: auth.audience,
        namespace,
        methods: exactMethods,
        lexicons: new URL("/lexicons", options.service.endpoint).href,
        spacesAlpha: "0.0.0-spaces-alpha-20260818163953",
      });
    }

    const method = xrpcMethod(url.pathname);
    if (!method) return json({ error: "NotFound" }, 404);
    const { db, init, engine } = runtime(env);
    await init;

    if (method === `${namespace}.${AUTHORIZE_SPACE_METHOD}` && request.method === "POST") {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const body = await boundedJsonBody<{
        space?: unknown;
        delegation?: unknown;
        rediscover?: unknown;
      }>(request);
      const parsed = parseSpaceUri(body.space);
      if (!options.spaceTypes[parsed.type]) {
        return privateJson({ error: "UnsupportedSpace" }, 400);
      }
      if (typeof body.delegation !== "string" || !body.delegation) {
        return privateJson({ error: "InvalidRequest", message: "delegation is required" }, 400);
      }
      const claims = decodeJwtClaims(body.delegation);
      const delegationDid = typeof claims.iss === "string"
        ? baseDid(claims.iss)
        : typeof claims.sub === "string"
          ? baseDid(claims.sub)
          : null;
      if (delegationDid !== verified.did) {
        return privateJson({ error: "DelegationIssuerMismatch" }, 403);
      }
      if (typeof claims.sub === "string" && claims.sub !== parsed.uri) {
        return privateJson({ error: "DelegationSpaceMismatch" }, 403);
      }
      if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
        return privateJson({ error: "DelegationExpired" }, 401);
      }
      const existingWatch = await getSpaceWatch(db, parsed.uri);
      if (existingWatch?.status === "hidden" && body.rediscover !== true) {
        return privateJson({ error: "RediscoveryRequired" }, 409);
      }
      if (body.rediscover === true && existingWatch?.status !== "hidden") {
        return privateJson({ error: "RediscoveryNotAllowed" }, 409);
      }
      const authorityPds = await engine.identities.resolvePds(parsed.authorityDid);
      const transport = await exchangeSpaceCredential({
        authorityPds,
        delegationToken: body.delegation,
        spaceUri: parsed.uri,
        fetch: options.protocol?.fetch,
      });
      const provisionalWatch: SpaceWatch = existingWatch ?? {
        spaceUri: parsed.uri,
        authorityDid: parsed.authorityDid,
        spaceType: parsed.type,
        generation: 1,
        status: "active",
        registrationExpiresAt: null,
        nextReconcileAt: Date.now(),
        lastReconciledAt: null,
        lastError: null,
      };
      await engine.validateWatch(provisionalWatch, transport);
      const watch = body.rediscover === true
        ? await rediscoverSpace(db, parsed.uri)
        : await ensureSpaceWatch(db, { spaceUri: parsed.uri });
      await saveCredential(db, {
        spaceUri: parsed.uri,
        generation: watch.generation,
        viewerDid: verified.did!,
        credential: transport.serialize(),
        encryptionKey: stringBinding(env, encryptionBinding),
      });
      const leaseExpiry = Math.min(
        transport.expiresAt,
        Date.now() + (options.accessLeaseMs ?? 15 * 60_000),
      );
      await saveAccessLease(db, {
        userDid: verified.did!,
        spaceUri: parsed.uri,
        generation: watch.generation,
        expiresAt: leaseExpiry,
      });
      await updateWatch(db, parsed.uri, {
        status: "active",
        error: null,
        nextReconcileAt: Date.now(),
        expectedGeneration: watch.generation,
      });
      await enqueue(env, ctx, { kind: "reconcile", space: parsed.uri }, () =>
        engine.reconcileSpace(parsed.uri));
      return privateJson({
        space: parsed.uri,
        generation: watch.generation,
        accessExpiresAt: new Date(leaseExpiry).toISOString(),
      });
    }

    if (method === `${namespace}.${SYNC_SPACE_METHOD}` && request.method === "POST") {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const body = await boundedJsonBody<{ space?: unknown; repo?: unknown }>(request);
      const parsed = parseSpaceUri(body.space);
      const watch = await getSpaceWatch(db, parsed.uri);
      if (!watch || watch.status === "hidden") return privateJson({ error: "SpaceNotFound" }, 404);
      if (!await accessAllowed(env, db, watch, {
        userDid: verified.did!, spaceUri: parsed.uri, action: "read", method,
      })) return privateJson({ error: "Forbidden" }, 403);
      if (body.repo !== undefined && !validDid(body.repo)) {
        return privateJson({ error: "InvalidRequest", message: "invalid repo DID" }, 400);
      }
      // Consumer-triggered sync always starts from the authority's complete
      // writer list. The optional repo hint must never admit an unadvertised or
      // previously removed writer; trusted authority notifications retain the
      // targeted fast path below.
      const preferredRepo = validDid(body.repo) ? body.repo : undefined;
      await enqueue(
        env,
        ctx,
        { kind: "reconcile", space: parsed.uri, preferredRepo },
        () => engine.reconcileSpace(parsed.uri, { preferredRepo }),
      );
      return privateJson({ queued: true }, 202);
    }

    if (method === `${namespace}.${LIST_SPACES_METHOD}` && request.method === "GET") {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 ||
        requestedLimit > 200 || (cursor?.length ?? 0) > 2_048) {
        return privateJson({ error: "InvalidRequest" }, 400);
      }
      const indexed = await listConnectedSpaceWatches(db, {
        userDid: verified.did!,
        cursor,
        limit: requestedLimit + 1,
      });
      const watches = new Map(indexed.map((watch) => [watch.spaceUri, watch]));
      let customTruncated = false;
      if (options.authorization?.listSpaces) {
        const listed = await options.authorization.listSpaces(verified.did!, { env, db });
        customTruncated = listed.length > 1_000;
        for (const spaceUri of listed.slice(0, 1_000)) {
          if (typeof spaceUri !== "string" || spaceUri <= (cursor ?? "")) continue;
          try {
            parseSpaceUri(spaceUri);
          } catch {
            continue;
          }
          const watch = await getSpaceWatch(db, spaceUri);
          if (!watch || watch.status !== "active") continue;
          if (await accessAllowed(env, db, watch, {
            userDid: verified.did!,
            spaceUri,
            action: "read",
            method,
          })) watches.set(spaceUri, watch);
        }
      }
      const ordered = [...watches.values()].sort((a, b) =>
        a.spaceUri.localeCompare(b.spaceUri)
      );
      const truncated = customTruncated || ordered.length > requestedLimit;
      const page = ordered.slice(0, requestedLimit);
      const spaces = page.map((watch) => ({
        uri: watch.spaceUri,
        authorityDid: watch.authorityDid,
        type: watch.spaceType,
      }));
      return privateJson({
        spaces,
        truncated,
        ...(truncated && page.length ? { cursor: page.at(-1)!.spaceUri } : {}),
      });
    }

    if (
      subscriptionsEnabled &&
      method === `${namespace}.${SUBSCRIBE_SPACE_METHOD}` &&
      request.method === "POST"
    ) {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const body = await boundedJsonBody<{ space?: unknown }>(request);
      const parsed = parseSpaceUri(body.space);
      const watch = await getSpaceWatch(db, parsed.uri);
      if (!watch || watch.status === "hidden") return privateJson({ error: "SpaceNotFound" }, 404);
      if (!await accessAllowed(env, db, watch, {
        userDid: verified.did!, spaceUri: parsed.uri, action: "read", method,
      })) return privateJson({ error: "Forbidden" }, 403);
      const ticket = crypto.randomUUID().replaceAll("-", "");
      const expiresAt = Date.now() + subscriptionTicketTtlMs;
      const issued = await subscriptionHub(env, parsed.uri).fetch(
        new Request("https://subscriptions.internal/issue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket, expiresAt }),
        }),
      );
      if (!issued.ok) return privateJson({ error: "SubscriptionUnavailable" }, 503);
      const socketUrl = new URL("/subscribe", options.service.endpoint);
      socketUrl.protocol = socketUrl.protocol === "http:" ? "ws:" : "wss:";
      socketUrl.searchParams.set("space", parsed.uri);
      socketUrl.searchParams.set("ticket", ticket);
      return privateJson({
        url: socketUrl.href,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }

    if (method === "com.atproto.space.notifyWrite" && request.method === "POST") {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const body = await boundedJsonBody<{
        space?: unknown;
        repo?: unknown;
        rev?: unknown;
        hash?: unknown;
      }>(request, 16 * 1024);
      const parsed = parseSpaceUri(body.space);
      const hash = decodeBytes(body.hash);
      if (!validDid(body.repo) || typeof body.rev !== "string" ||
        body.rev.length > 128 || !hash || hash.byteLength !== 32) {
        return json({ error: "InvalidRequest" }, 400);
      }
      if (verified.did !== parsed.authorityDid) {
        return json({ error: "InvalidIssuer" }, 403);
      }
      const repoDid = body.repo;
      const revision = body.rev;
      const watch = await getSpaceWatch(db, parsed.uri);
      if (watch?.status === "active") {
        await enqueue(env, ctx, {
          kind: "repo",
          space: parsed.uri,
          repo: repoDid,
          rev: revision,
          hash: encodeBytes(hash),
        }, () => engine.syncRepo(parsed.uri, repoDid, {
          rev: revision,
          hash,
        }));
      }
      return json({ queued: Boolean(watch) }, 202);
    }

    if (
      method === "com.atproto.space.notifySpaceDeleted" &&
      request.method === "POST"
    ) {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const body = await boundedJsonBody<{ space?: unknown }>(request, 8 * 1024);
      const parsed = parseSpaceUri(body.space);
      if (verified.did !== parsed.authorityDid) return json({ error: "InvalidIssuer" }, 403);
      const watch = await getSpaceWatch(db, parsed.uri);
      if (watch) {
        await hideDeletedSpace(db, watch);
        ctx.waitUntil((async () => {
          await purgeSpaceGeneration(db, projection, watch);
          await invalidate(parsed.uri, env);
        })());
      }
      return json({}, 200);
    }

    if (
      managingAppEnabled &&
      method === "com.atproto.simplespace.checkUserAccess" &&
      request.method === "GET"
    ) {
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const parsed = parseSpaceUri(url.searchParams.get("space"));
      const userDid = url.searchParams.get("user");
      if (!userDid) return json({ error: "InvalidRequest" }, 400);
      if (verified.did !== parsed.authorityDid) return json({ error: "InvalidIssuer" }, 403);
      const watch = await getSpaceWatch(db, parsed.uri);
      let authorized = userDid === parsed.authorityDid;
      if (!authorized && watch?.status === "active") {
        authorized = await accessAllowed(env, db, watch, {
          userDid,
          spaceUri: parsed.uri,
          action: "read",
          method,
        });
      } else if (!authorized && options.authorization) {
        // A custom policy may authorize before the first watch, or for a
        // verified recreation while the old generation remains hidden.
        authorized = await options.authorization.authorize({
          userDid,
          spaceUri: parsed.uri,
          action: "read",
          method,
        }, { env, db });
      }
      return json({ authorized });
    }

    for (const [short, collection] of Object.entries(projection.collections)) {
      const listMethod = collectionMethod(namespace, short, LIST_SPACE_RECORDS_METHOD);
      const getMethod = collectionMethod(namespace, short, GET_SPACE_RECORD_METHOD);
      if (method !== listMethod && method !== getMethod) continue;
      if (request.method !== "GET") return json({ error: "MethodNotAllowed" }, 405);
      const verified = await authorizeRequest(request, method);
      if (verified.response) return verified.response;
      const parsed = parseSpaceUri(url.searchParams.get("space"));
      const watch = await getSpaceWatch(db, parsed.uri);
      if (!watch || watch.status !== "active") {
        return privateJson({ error: "SpaceUnavailable" }, 404);
      }
      if (!await accessAllowed(env, db, watch, {
        userDid: verified.did!,
        spaceUri: parsed.uri,
        action: "read",
        method,
      })) return privateJson({ error: "Forbidden" }, 403);

      const filters: Record<string, string> = {};
      const ranges: Record<string, { min?: string; max?: string }> = {};
      for (const field of Object.keys(collection.queryable ?? {})) {
        const exact = url.searchParams.get(field);
        if (exact !== null) filters[field] = exact;
        const minimum = url.searchParams.get(`${field}Min`);
        const maximum = url.searchParams.get(`${field}Max`);
        if (minimum !== null || maximum !== null) {
          ranges[field] = {
            ...(minimum === null ? {} : { min: minimum }),
            ...(maximum === null ? {} : { max: maximum }),
          };
        }
      }
      const requestedUri = url.searchParams.get("uri");
      if (method === getMethod && !requestedUri) {
        return privateJson({ error: "InvalidRequest", message: "uri is required" }, 400);
      }
      const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
      if (method === listMethod &&
        (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)) {
        return privateJson({ error: "InvalidRequest", message: "invalid limit" }, 400);
      }
      const result = await queryIsolatedRecords(db, projection, {
        scope: {
          kind: "isolated",
          key: spaceProjectionKey(parsed.uri, watch.generation),
        },
        collection: short,
        ...(url.searchParams.get("did") ? { did: url.searchParams.get("did")! } : {}),
        ...(method === getMethod
          ? { uri: requestedUri!, limit: 1 }
          : {
              limit: requestedLimit,
              cursor: url.searchParams.get("cursor") ?? undefined,
              search: url.searchParams.get("search") ?? undefined,
            }),
        filters,
        rangeFilters: ranges,
      });
      if (method === getMethod) {
        const record = result.records[0];
        if (!record) return privateJson({ error: "RecordNotFound" }, 404);
        return privateJson({
          record: parsedRecord(record as unknown as Record<string, unknown>),
          references: Object.fromEntries(
            Object.entries(result.references ?? {}).map(([uri, row]) => [
              uri,
              parsedRecord(row as unknown as Record<string, unknown>),
            ]),
          ),
        });
      }
      return privateJson({
        records: result.records.map((row) =>
          parsedRecord(row as unknown as Record<string, unknown>)),
        ...(result.cursor ? { cursor: result.cursor } : {}),
        references: Object.fromEntries(
          Object.entries(result.references ?? {}).map(([uri, row]) => [
            uri,
            parsedRecord(row as unknown as Record<string, unknown>),
          ]),
        ),
      });
    }

    return json({ error: "MethodNotFound" }, 404);
  };

  return {
    fetch(request, env, ctx) {
      return handle(request, env, ctx).catch(errorResponse);
    },
    async scheduled(_controller, env, ctx) {
      const { init, engine } = runtime(env);
      await init;
      ctx.waitUntil(engine.reconcileDue({ deadline: Date.now() + 25_000, limit: 5 }));
    },
    async queue(batch, env) {
      const { init, engine } = runtime(env);
      await init;
      for (const message of batch.messages) {
        try {
          const body = message.body;
          if (body.kind === "reconcile") {
            await engine.reconcileSpace(body.space, { preferredRepo: body.preferredRepo });
          } else {
            await engine.syncRepo(body.space, body.repo, {
              rev: body.rev,
              hash: body.hash ? decodeBytes(body.hash) : undefined,
            });
          }
          message.ack();
        } catch (error) {
          console.error("[spaces] queue job failed", error);
          message.retry();
        }
      }
    },
  };
}
