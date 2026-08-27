import {
  getPdsEndpoint,
  getSigningDidKey,
  isValidDidDoc,
  type DidDocument,
} from "@atproto/common-web";
import { JoseKey } from "@atproto/jwk-jose";
import { createDpopProof } from "@atproto/space";
import { validateExternalUrl } from "@atmo-dev/contrail";
import { parseSpaceUri } from "./uri";

export interface ProtocolOptions {
  plcUrl?: string;
  fetch?: typeof globalThis.fetch;
  additionalAllowedHosts?: string[];
}

// Workerd requires platform methods to be invoked with the global object as
// their receiver. Keep the wrapper rather than storing an unbound `fetch`.
const runtimeFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);

export class SpaceProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SpaceProtocolError";
  }

  get accessDenied(): boolean {
    return [
      "UserNotAuthorized",
      "AppNotAuthorized",
      "NotAuthorized",
      "InvalidDelegationToken",
      "InvalidClientAttestation",
      "AuthRequired",
    ].includes(this.code) || this.status === 401 || this.status === 403;
  }

  get deleted(): boolean {
    return this.code === "SpaceDeleted";
  }

  get notFound(): boolean {
    return this.code === "SpaceNotFound" || this.status === 404;
  }
}

export class SpaceIdentityResolver {
  private readonly cache = new Map<string, DidDocument>();

  constructor(readonly options: ProtocolOptions = {}) {}

  private async resolveDid(did: string, forceRefresh = false): Promise<DidDocument> {
    if (!forceRefresh) {
      const cached = this.cache.get(did);
      if (cached) return cached;
    }
    let url: URL;
    if (did.startsWith("did:plc:")) {
      url = new URL(
        `/${encodeURIComponent(did)}`,
        this.options.plcUrl ?? "https://plc.directory",
      );
    } else if (did.startsWith("did:web:")) {
      const parts = did.slice("did:web:".length).split(":").map(decodeURIComponent);
      if (parts.length !== 1 || !parts[0]) {
        throw new Error(`Unsupported did:web identifier: ${did}`);
      }
      url = new URL(`https://${parts[0]}/.well-known/did.json`);
      if (url.hostname === "localhost") url.protocol = "http:";
    } else {
      throw new Error(`Unsupported DID method: ${did}`);
    }
    if (!validateExternalUrl(url.href, this.options.additionalAllowedHosts)) {
      throw new Error(`${did} resolved through a disallowed identity endpoint`);
    }
    const response = await (this.options.fetch ?? runtimeFetch)(url, {
      redirect: "manual",
      headers: { accept: "application/did+ld+json,application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Could not resolve ${did} (${response.status})`);
    }
    const document: unknown = await response.json();
    if (!isValidDidDoc(document) || document.id !== did) {
      throw new Error(`Invalid DID document for ${did}`);
    }
    this.cache.set(did, document);
    return document;
  }

  async resolvePds(did: string): Promise<string> {
    const endpoint = getPdsEndpoint(await this.resolveDid(did));
    if (!endpoint) throw new Error(`${did} has no PDS endpoint`);
    if (!validateExternalUrl(endpoint, this.options.additionalAllowedHosts)) {
      throw new Error(`${did} resolved to a disallowed PDS endpoint`);
    }
    return endpoint.replace(/\/$/, "");
  }

  async resolveSigningKey(did: string, forceRefresh = false): Promise<string> {
    if (did.startsWith("did:key:")) return did;
    const key = getSigningDidKey(await this.resolveDid(did, forceRefresh));
    if (!key) throw new Error(`${did} has no AT Protocol signing key`);
    return key;
  }
}

export interface StoredSpaceCredential {
  token: string;
  privateJwk: Record<string, unknown>;
  expiresAt: number;
}

export class SpaceCredentialTransport {
  constructor(
    readonly token: string,
    readonly key: JoseKey,
    readonly expiresAt: number,
    private readonly fetchImpl: typeof globalThis.fetch = runtimeFetch,
  ) {}

  static async restore(
    value: StoredSpaceCredential,
    fetchImpl: typeof globalThis.fetch = runtimeFetch,
  ): Promise<SpaceCredentialTransport> {
    const key = await JoseKey.fromJWK(value.privateJwk);
    return new SpaceCredentialTransport(value.token, key, value.expiresAt, fetchImpl);
  }

  serialize(): StoredSpaceCredential {
    const privateJwk = this.key.privateJwk;
    if (!privateJwk) throw new Error("DPoP key is not exportable");
    return {
      token: this.token,
      privateJwk: { ...privateJwk },
      expiresAt: this.expiresAt,
    };
  }

  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (Date.now() >= this.expiresAt) {
      throw new SpaceProtocolError(401, "CredentialExpired");
    }
    // Cloudflare Workers support only follow/manual. Manual preserves the
    // no-follow SSRF boundary while allowing callers to reject 3xx responses.
    const request = new Request(input, { ...init, redirect: "manual" });
    request.headers.set("authorization", `DPoP ${this.token}`);
    request.headers.set(
      "dpop",
      await createDpopProof(this.key, {
        htm: request.method,
        htu: request.url,
        credential: this.token,
      }),
    );
    return this.fetchImpl(request);
  };
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** Decode AT Protocol JSON bytes while leaving ordinary record objects intact. */
function decodeLexJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeLexJson);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.$bytes === "string") {
    return decodeBase64(object.$bytes);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, decodeLexJson(item)]),
  );
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return decodeLexJson(await response.json());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function assertResponse<T>(response: Response): Promise<T> {
  const body = await responseBody(response);
  if (!response.ok) {
    const object = body && typeof body === "object"
      ? body as Record<string, unknown>
      : undefined;
    const code = typeof object?.error === "string"
      ? object.error
      : response.status >= 500
        ? "UpstreamFailure"
        : "InvalidRequest";
    const message = typeof object?.message === "string" ? object.message : undefined;
    throw new SpaceProtocolError(response.status, code, message);
  }
  return body as T;
}

function xrpcUrl(service: string, method: string, params?: Record<string, unknown>): URL {
  const url = new URL(`/xrpc/${method}`, service);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function exchangeSpaceCredential(input: {
  authorityPds: string;
  delegationToken: string;
  spaceUri: string;
  clientAttestation?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<SpaceCredentialTransport> {
  parseSpaceUri(input.spaceUri);
  const key = await JoseKey.generate(["ES256"]);
  const request = new Request(
    xrpcUrl(input.authorityPds, "com.atproto.space.getSpaceCredential"),
    {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.delegationToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        space: input.spaceUri,
        ...(input.clientAttestation
          ? { clientAttestation: input.clientAttestation }
          : {}),
      }),
    },
  );
  request.headers.set(
    "dpop",
    await createDpopProof(key, { htm: request.method, htu: request.url }),
  );
  const response = await (input.fetch ?? runtimeFetch)(request);
  const body = await assertResponse<{ credential?: unknown }>(response);
  if (typeof body?.credential !== "string" || !body.credential) {
    throw new SpaceProtocolError(502, "InvalidResponse", "No Space credential returned");
  }
  const claims = JSON.parse(
    new TextDecoder().decode(decodeBase64(body.credential.split(".")[1] ?? "")),
  ) as { exp?: unknown };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new SpaceProtocolError(502, "InvalidResponse", "Credential has no valid expiry");
  }
  return new SpaceCredentialTransport(
    body.credential,
    key,
    claims.exp * 1000,
    input.fetch ?? runtimeFetch,
  );
}

async function credentialQuery<T>(
  transport: SpaceCredentialTransport,
  service: string,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return assertResponse<T>(await transport.fetch(xrpcUrl(service, method, params), {
    headers: { accept: "application/json" },
    signal: options.signal,
  }));
}

async function credentialProcedure<T>(
  transport: SpaceCredentialTransport,
  service: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  return assertResponse<T>(await transport.fetch(xrpcUrl(service, method), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export interface SpaceDescription {
  uri: string;
  policy: { $type?: string; managingApp?: string; [key: string]: unknown };
  appAccess: { $type?: string; [key: string]: unknown };
}

export function getSpace(
  transport: SpaceCredentialTransport,
  authorityPds: string,
  spaceUri: string,
): Promise<SpaceDescription> {
  return credentialQuery(transport, authorityPds, "com.atproto.simplespace.getSpace", {
    space: spaceUri,
  });
}

export interface ListedRepo {
  did: string;
  rev: string;
  hash: Uint8Array;
}

export interface ListReposOutput {
  repos: ListedRepo[];
  cursor?: string;
}

export function listRepos(
  transport: SpaceCredentialTransport,
  authorityPds: string,
  input: { space: string; limit?: number; cursor?: string },
): Promise<ListReposOutput> {
  return credentialQuery(transport, authorityPds, "com.atproto.space.listRepos", input);
}

export interface RepoOp {
  rev: string;
  collection: string;
  rkey: string;
  cid: string | null;
  prev: string | null;
  value?: unknown;
}

export interface SignedCommitInput {
  ver: number;
  hash: Uint8Array;
  ikm: Uint8Array;
  sig: Uint8Array;
  mac: Uint8Array;
  rev: string;
}

export interface ListRepoOpsOutput {
  ops: RepoOp[];
  commit?: SignedCommitInput;
  cursor?: string;
}

export function listRepoOps(
  transport: SpaceCredentialTransport,
  writerPds: string,
  input: {
    space: string;
    repo: string;
    since: string;
    limit?: number;
    cursor?: string;
  },
  options: { signal?: AbortSignal } = {},
): Promise<ListRepoOpsOutput> {
  return credentialQuery(
    transport,
    writerPds,
    "com.atproto.space.listRepoOps",
    input,
    options,
  );
}

export async function getRepoCar(
  transport: SpaceCredentialTransport,
  writerPds: string,
  input: { space: string; repo: string; maxBytes?: number },
): Promise<Uint8Array> {
  const response = await transport.fetch(
    xrpcUrl(writerPds, "com.atproto.space.getRepo", {
      space: input.space,
      repo: input.repo,
    }),
    { headers: { accept: "application/vnd.ipld.car" } },
  );
  if (!response.ok) await assertResponse(response);
  const maximum = input.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("maxBytes must be a positive integer");
  }
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new SpaceProtocolError(413, "RepoTooLarge");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maximum) {
        try {
          await reader.cancel("RepoTooLarge");
        } catch {
          // The size violation is authoritative even if the peer rejects cancel.
        }
        throw new SpaceProtocolError(413, "RepoTooLarge");
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function registerNotify(
  transport: SpaceCredentialTransport,
  authorityPds: string,
  input: { space: string; service: string },
): Promise<{ expiresAt: string }> {
  return credentialProcedure(
    transport,
    authorityPds,
    "com.atproto.space.registerNotify",
    input,
  );
}
