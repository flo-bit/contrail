import {
  getPdsEndpoint,
  getSigningDidKey,
  isValidDidDoc,
  type DidDocument,
} from "@atproto/common-web";
import { P256Keypair, formatDidKey, parseMultikey } from "@atproto/crypto";
import { jsonToLex } from "@atproto/lex-json";
import {
  createSpaceSigHeaders,
  encapsulate,
  formatWantMacHeader,
  parseMacHeader,
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  WANT_MAC_HEADER,
  RECORD_MAC_TYPE,
  verifyRecord,
  type Commit,
  type SpaceRecord,
} from "@atproto/space";
import { validateExternalUrl } from "@atmo-dev/contrail";
import { formatSpaceRecordUri, parseSpaceUri } from "./uri";

export interface ProtocolOptions {
  plcUrl?: string;
  fetch?: typeof globalThis.fetch;
  additionalAllowedHosts?: string[];
}
const runtimeFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);

export class SpaceProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "SpaceProtocolError";
  }
  get accessDenied(): boolean {
    return (
      [
        "SpaceNotFound", // The authority conceals unauthorized spaces.
        "UserNotAuthorized",
        "AppNotAuthorized",
        "NotAuthorized",
        "InvalidDelegationToken",
        "InvalidClientAttestation",
        "AuthRequired",
        "CredentialRevoked",
      ].includes(this.code) ||
      this.status === 401 ||
      this.status === 403
    );
  }
  get deleted(): boolean {
    return this.code === "SpaceDeleted";
  }
  get notFound(): boolean {
    return this.code === "SpaceNotFound" || this.status === 404;
  }
}

export class SpaceIdentityResolver {
  private readonly cache = new Map<
    string,
    { document: DidDocument; expiresAt: number }
  >();
  constructor(readonly options: ProtocolOptions = {}) {}
  private async resolveDid(
    did: string,
    forceRefresh = false,
  ): Promise<DidDocument> {
    const cached = this.cache.get(did);
    if (!forceRefresh && cached && cached.expiresAt > Date.now())
      return cached.document;
    let url: URL;
    if (did.startsWith("did:plc:")) {
      url = new URL(
        `/${encodeURIComponent(did)}`,
        this.options.plcUrl ?? "https://plc.directory",
      );
    } else if (did.startsWith("did:web:")) {
      const parts = did.slice(8).split(":").map(decodeURIComponent);
      if (parts.length !== 1 || !parts[0])
        throw new Error(`Unsupported did:web identifier: ${did}`);
      url = new URL(`https://${parts[0]}/.well-known/did.json`);
      if (url.hostname === "localhost") url.protocol = "http:";
    } else throw new Error(`Unsupported DID method: ${did}`);
    if (!validateExternalUrl(url.href, this.options.additionalAllowedHosts)) {
      throw new Error(`${did} resolved through a disallowed identity endpoint`);
    }
    const response = await (this.options.fetch ?? runtimeFetch)(url, {
      redirect: "manual",
      headers: { accept: "application/did+ld+json,application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`Could not resolve ${did} (${response.status})`);
    const document: unknown = await response.json();
    if (!isValidDidDoc(document) || document.id !== did)
      throw new Error(`Invalid DID document for ${did}`);
    this.cache.delete(did);
    if (this.cache.size >= 1024)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(did, { document, expiresAt: Date.now() + 60_000 });
    return document;
  }
  async resolvePds(did: string, forceRefresh = false): Promise<string> {
    const endpoint = getPdsEndpoint(await this.resolveDid(did, forceRefresh));
    if (
      !endpoint ||
      !validateExternalUrl(endpoint, this.options.additionalAllowedHosts)
    ) {
      throw new Error(`${did} has no allowed PDS endpoint`);
    }
    return endpoint.replace(/\/$/, "");
  }
  async resolveSigningKey(did: string, forceRefresh = false): Promise<string> {
    if (did.startsWith("did:key:")) return did;
    const key = getSigningDidKey(await this.resolveDid(did, forceRefresh));
    if (!key) throw new Error(`${did} has no AT Protocol signing key`);
    return key;
  }
  async resolveKemKey(did: string, forceRefresh = false): Promise<string> {
    const doc = await this.resolveDid(did, forceRefresh);
    const key = doc.verificationMethod?.find(
      (method) =>
        method.id === `${did}#atproto_kem` || method.id === "#atproto_kem",
    );
    if (
      !key ||
      key.controller !== did ||
      key.type !== "Multikey" ||
      !key.publicKeyMultibase
    ) {
      throw new Error(`${did} has no published KEM key`);
    }
    const parsed = parseMultikey(key.publicKeyMultibase);
    if (parsed.jwtAlg !== "ES256") throw new Error("KEM key must be P-256");
    return formatDidKey(parsed.jwtAlg, parsed.keyBytes);
  }
}

export interface StoredSpaceCredential {
  format: "http-signature-v1";
  token: string;
  privateKey: string;
  expiresAt: number;
}
export class SpaceCredentialTransport {
  constructor(
    readonly token: string,
    readonly key: P256Keypair,
    readonly expiresAt: number,
    private readonly fetchImpl: typeof globalThis.fetch = runtimeFetch,
  ) {}
  static async restore(
    value: StoredSpaceCredential,
    fetchImpl = runtimeFetch,
  ): Promise<SpaceCredentialTransport> {
    if (value.format !== "http-signature-v1")
      throw new SpaceProtocolError(401, "CredentialExpired");
    return new SpaceCredentialTransport(
      value.token,
      await P256Keypair.import(decodeBase64(value.privateKey), {
        exportable: true,
      }),
      value.expiresAt,
      fetchImpl,
    );
  }
  async serialize(): Promise<StoredSpaceCredential> {
    return {
      format: "http-signature-v1",
      token: this.token,
      privateKey: btoa(String.fromCharCode(...(await this.key.export()))),
      expiresAt: this.expiresAt,
    };
  }
  fetch = async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    audience: string,
  ): Promise<Response> => {
    if (Date.now() >= this.expiresAt)
      throw new SpaceProtocolError(401, "CredentialExpired");
    if (!audience?.startsWith("did:"))
      throw new TypeError("An exact account audience is required");
    const request = new Request(input, {
      ...init,
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    const headers = await createSpaceSigHeaders(this.key, {
      authorization: `Atproto-Space-Credential ${this.token}`,
      audience: audience as never,
    });
    for (const [name, value] of Object.entries(headers))
      request.headers.set(name, value);
    return this.fetchImpl(request);
  };
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
}
async function assertResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = jsonToLex(await response.json());
  } catch {
    /* handled below */
  }
  if (!response.ok) {
    const object = body as Record<string, unknown> | undefined;
    throw new SpaceProtocolError(
      response.status,
      typeof object?.error === "string" ? object.error : "UpstreamFailure",
      typeof object?.message === "string" ? object.message : undefined,
    );
  }
  if (!body || typeof body !== "object")
    throw new SpaceProtocolError(502, "InvalidResponse");
  return body as T;
}
function xrpcUrl(service: string, method: string, params: object = {}): URL {
  const url = new URL(`/xrpc/${method}`, service);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, String(value));
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
  const key = await P256Keypair.create({ exportable: true });
  const response = await (input.fetch ?? runtimeFetch)(
    new Request(
      xrpcUrl(input.authorityPds, "com.atproto.space.getSpaceCredential"),
      {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          space: input.spaceUri,
          credentialKid: key.did(),
          delegationToken: input.delegationToken,
          clientAttestation: input.clientAttestation,
        }),
      },
    ),
  );
  const body = await assertResponse<{ credential: string }>(response);
  if (typeof body.credential !== "string")
    throw new SpaceProtocolError(502, "InvalidResponse");
  const claims = JSON.parse(
    new TextDecoder().decode(decodeBase64(body.credential.split(".")[1] ?? "")),
  );
  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64(body.credential.split(".")[0] ?? "")),
  );
  if (
    header.typ !== "atproto-space-credential+jwt" ||
    header.kid !== "#atproto" ||
    claims.iss !== parseSpaceUri(input.spaceUri).authorityDid ||
    claims.sub !== input.spaceUri ||
    claims.cnf?.kid !== key.did() ||
    typeof claims.jti !== "string" ||
    !claims.jti ||
    !Number.isFinite(claims.exp) ||
    !Number.isFinite(claims.iat) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 3600 ||
    claims.iat > Date.now() / 1000 + 5 ||
    claims.exp * 1000 <= Date.now()
  ) {
    throw new SpaceProtocolError(
      502,
      "InvalidResponse",
      "Invalid credential claims",
    );
  }
  return new SpaceCredentialTransport(
    body.credential,
    key,
    claims.exp * 1000,
    input.fetch ?? runtimeFetch,
  );
}
async function query<T>(
  transport: SpaceCredentialTransport,
  service: string,
  method: string,
  params: { space: string; repo?: string } & object,
): Promise<T> {
  return assertResponse<T>(
    await transport.fetch(
      xrpcUrl(service, method, params),
      {
        headers: { accept: "application/json" },
      },
      params.repo ?? parseSpaceUri(params.space).authorityDid,
    ),
  );
}
/** Only the authority's published copy is authoritative. Never use getSpace
 * here: that method now requires owner OAuth, not a Space credential. */
export async function getPublishedSpacePolicy(
  transport: SpaceCredentialTransport,
  authorityPds: string,
  spaceUri: string,
  options: { kemDidKey: string },
): Promise<unknown> {
  const repo = parseSpaceUri(spaceUri).authorityDid;
  const collection = "com.atproto.space.policy";
  const rkey = "self";
  const uri = formatSpaceRecordUri({
    spaceUri,
    writerDid: repo,
    collection,
    rkey,
  });
  const { keyShare, sharedSecret } = await encapsulate(options.kemDidKey);
  const response = await transport.fetch(
    xrpcUrl(authorityPds, "com.atproto.space.getRecord", {
      space: spaceUri,
      repo,
      collection,
      rkey,
    }),
    {
      headers: {
        accept: "application/json",
        [WANT_MAC_HEADER]: formatWantMacHeader(RECORD_MAC_TYPE, keyShare),
      },
    },
    repo,
  );
  const record = await assertResponse<{
    uri: string;
    cid: string;
    value: SpaceRecord;
  }>(response);
  const mac = parseMacHeader(
    response.headers.get(MAC_HEADER) ?? undefined,
    RECORD_MAC_TYPE,
  );
  if (
    !(await verifyRecord(record, { uri, sharedSecret, mac })) ||
    record.value.$type !== collection
  ) {
    throw new Error("Published policy record verification failed");
  }
  return record.value.policy;
}
export interface ListedRepo {
  did: string;
  repoRev: string;
  data: Uint8Array;
  spaceRev: string;
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
  return query(transport, authorityPds, "com.atproto.space.listRepos", input);
}
export interface RepoOp {
  rev: string;
  collection: `${string}.${string}.${string}`;
  rkey: string;
  cid: string | null;
  prev: string | null;
  value?: SpaceRecord;
}
export interface ListRepoOpsOutput {
  ops: RepoOp[];
  commit?: Commit;
  cursor?: string;
  sharedSecret: Uint8Array;
  mac?: Uint8Array;
}
export async function listRepoOps(
  transport: SpaceCredentialTransport,
  writerPds: string,
  input: {
    space: string;
    repo: string;
    since: string;
    limit?: number;
    cursor?: string;
  },
  options: { signal?: AbortSignal; kemDidKey: string },
): Promise<ListRepoOpsOutput> {
  const { keyShare, sharedSecret } = await encapsulate(options.kemDidKey);
  const response = await transport.fetch(
    xrpcUrl(writerPds, "com.atproto.space.listRepoOps", input),
    {
      headers: {
        accept: "application/json",
        [WANT_MAC_HEADER]: formatWantMacHeader(COMMIT_MAC_TYPE, keyShare),
      },
      signal: options.signal,
    },
    input.repo,
  );
  const body =
    await assertResponse<Omit<ListRepoOpsOutput, "sharedSecret" | "mac">>(
      response,
    );
  const mac = body.commit
    ? parseMacHeader(
        response.headers.get(MAC_HEADER) ?? undefined,
        COMMIT_MAC_TYPE,
      )
    : undefined;
  return { ...body, sharedSecret, mac };
}
export async function getRepoStar(
  transport: SpaceCredentialTransport,
  writerPds: string,
  input: { space: string; repo: string; kemDidKey: string; maxBytes?: number },
): Promise<{
  bytes: Uint8Array;
  sharedSecret: Uint8Array;
  mac: Uint8Array;
}> {
  const { keyShare, sharedSecret } = await encapsulate(input.kemDidKey);
  const response = await transport.fetch(
    xrpcUrl(writerPds, "com.atproto.space.getRepo", {
      space: input.space,
      repo: input.repo,
    }),
    {
      headers: {
        accept: "application/octet-stream",
        [WANT_MAC_HEADER]: formatWantMacHeader(COMMIT_MAC_TYPE, keyShare),
      },
    },
    input.repo,
  );
  if (!response.ok) await assertResponse(response);
  const mac = parseMacHeader(
    response.headers.get(MAC_HEADER) ?? undefined,
    COMMIT_MAC_TYPE,
  );
  const maximum = input.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new TypeError("maxBytes must be positive");
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new SpaceProtocolError(413, "RepoTooLarge");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SpaceProtocolError(502, "InvalidResponse");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new SpaceProtocolError(413, "RepoTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, sharedSecret, mac };
}
export async function registerNotify(
  transport: SpaceCredentialTransport,
  authorityPds: string,
  input: { space: string; service: string },
): Promise<{ expiresAt: string }> {
  return assertResponse(
    await transport.fetch(
      xrpcUrl(authorityPds, "com.atproto.space.registerNotify"),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
      parseSpaceUri(input.space).authorityDid,
    ),
  );
}
