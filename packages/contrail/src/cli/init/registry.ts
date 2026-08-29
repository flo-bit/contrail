import {
  isDid,
  isNsid,
  isResourceUri,
} from "@atcute/lexicons/syntax";

export const DEFAULT_LEXICON_API = "https://lex.atmo.tools";
const DEFAULT_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_DOCUMENTS = 2_000;
const MAX_SNAPSHOT_RESTARTS = 5;

export interface VerificationSummary {
  candidates: number;
  verified: number;
  pending: number;
  stale: number;
  temporaryFailure: number;
  unresolved: number;
  invalid: number;
  settled: boolean;
  allVerified: boolean;
}

export interface IndexingSummary {
  available: boolean;
  relayDiscoveryComplete: boolean;
  backfillsPending: number;
  backfillsExhausted: number;
  settled: boolean;
  complete: boolean;
}

export interface VerifiedLexiconDocument {
  id: string;
  authorityDid: string;
  uri: string;
  cid: string;
  value: Record<string, unknown>;
  verifiedAt: string;
  verifiedUntil: string;
}

export interface PrefixImport {
  api: string;
  prefix: string;
  snapshot: string;
  partial: boolean;
  verification: VerificationSummary;
  indexing: IndexingSummary;
  documents: VerifiedLexiconDocument[];
}

export interface RegistryClientOptions {
  api?: string;
  timeoutMs?: number;
  allowPartial?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface PrefixPage {
  prefix: string;
  verified: true;
  snapshot: string;
  lexicons: VerifiedLexiconDocument[];
  cursor?: string;
  verification: VerificationSummary;
  indexing: IndexingSummary;
}

interface ErrorBody {
  error?: string;
  id?: string;
  status?: string;
  retryAt?: string;
}

export class LexiconRegistryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LexiconRegistryError";
  }
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LexiconRegistryError(
      `Lexicon API returned an invalid ${name}`,
      "InvalidResponse",
    );
  }
  return value;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new LexiconRegistryError(
      `Lexicon API returned an invalid ${name}`,
      "InvalidResponse",
    );
  }
  return value;
}

function objectField(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LexiconRegistryError(
      `Lexicon API returned an invalid ${name}`,
      "InvalidResponse",
    );
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LexiconRegistryError(
      `Lexicon API returned an invalid ${name}`,
      "InvalidResponse",
    );
  }
  return value;
}

function verificationSummary(value: unknown): VerificationSummary {
  const input = objectField(value, "verification summary");
  return {
    candidates: numberField(input.candidates, "verification.candidates"),
    verified: numberField(input.verified, "verification.verified"),
    pending: numberField(input.pending, "verification.pending"),
    stale: numberField(input.stale, "verification.stale"),
    temporaryFailure: numberField(
      input.temporaryFailure,
      "verification.temporaryFailure",
    ),
    unresolved: numberField(input.unresolved, "verification.unresolved"),
    invalid: numberField(input.invalid, "verification.invalid"),
    settled: booleanField(input.settled, "verification.settled"),
    allVerified: booleanField(
      input.allVerified,
      "verification.allVerified",
    ),
  };
}

function indexingSummary(value: unknown): IndexingSummary {
  const input = objectField(value, "indexing summary");
  return {
    available: booleanField(input.available, "indexing.available"),
    relayDiscoveryComplete: booleanField(
      input.relayDiscoveryComplete,
      "indexing.relayDiscoveryComplete",
    ),
    backfillsPending: numberField(
      input.backfillsPending,
      "indexing.backfillsPending",
    ),
    backfillsExhausted: numberField(
      input.backfillsExhausted,
      "indexing.backfillsExhausted",
    ),
    settled: booleanField(input.settled, "indexing.settled"),
    complete: booleanField(input.complete, "indexing.complete"),
  };
}

export function parseVerifiedDocument(
  value: unknown,
  now = Date.now(),
): VerifiedLexiconDocument {
  const input = objectField(value, "verified Lexicon");
  const id = stringField(input.id, "Lexicon id");
  if (!isNsid(id)) {
    throw new LexiconRegistryError(
      `Lexicon API returned an invalid NSID: ${id}`,
      "InvalidResponse",
    );
  }
  const document = objectField(input.value, `Lexicon ${id} value`);
  if (document.id !== id) {
    throw new LexiconRegistryError(
      `Lexicon API document ID mismatch for ${id}`,
      "InvalidResponse",
    );
  }
  const verifiedAt = stringField(input.verifiedAt, `${id}.verifiedAt`);
  const verifiedUntil = stringField(input.verifiedUntil, `${id}.verifiedUntil`);
  if (!Number.isFinite(Date.parse(verifiedAt))) {
    throw new LexiconRegistryError(
      `Lexicon API returned an invalid verifiedAt for ${id}`,
      "InvalidResponse",
    );
  }
  const expiry = Date.parse(verifiedUntil);
  if (!Number.isFinite(expiry) || expiry <= now) {
    throw new LexiconRegistryError(
      `Lexicon API returned an expired verification for ${id}`,
      "ExpiredVerification",
    );
  }
  const authorityDid = stringField(input.authorityDid, `${id}.authorityDid`);
  const uri = stringField(input.uri, `${id}.uri`);
  if (!isDid(authorityDid) || !isResourceUri(uri)) {
    throw new LexiconRegistryError(
      `Lexicon API returned invalid provenance for ${id}`,
      "InvalidResponse",
    );
  }
  return {
    id,
    authorityDid,
    uri,
    cid: stringField(input.cid, `${id}.cid`),
    value: document,
    verifiedAt,
    verifiedUntil,
  };
}

function parsePrefixPage(
  value: unknown,
  expectedPrefix: string,
  now: number,
): PrefixPage {
  const input = objectField(value, "prefix response");
  if (input.verified !== true || input.prefix !== expectedPrefix) {
    throw new LexiconRegistryError(
      "Lexicon API returned the wrong prefix or an unverified response",
      "InvalidResponse",
    );
  }
  if (!Array.isArray(input.lexicons)) {
    throw new LexiconRegistryError(
      "Lexicon API response must contain a lexicons array",
      "InvalidResponse",
    );
  }
  return {
    prefix: expectedPrefix,
    verified: true,
    snapshot: stringField(input.snapshot, "snapshot"),
    lexicons: input.lexicons.map((document) =>
      parseVerifiedDocument(document, now),
    ),
    ...(input.cursor === undefined
      ? {}
      : { cursor: stringField(input.cursor, "cursor") }),
    verification: verificationSummary(input.verification),
    indexing: indexingSummary(input.indexing),
  };
}

function normalizeApi(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new LexiconRegistryError(
      `Invalid Lexicon API URL: ${input}`,
      "InvalidEndpoint",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new LexiconRegistryError(
      "Lexicon API URL must be an origin without credentials, path, query, or hash",
      "InvalidEndpoint",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new LexiconRegistryError(
      "Lexicon API must use HTTPS (HTTP is allowed only on loopback)",
      "InvalidEndpoint",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface RequestContext {
  fetcher: typeof fetch;
  api: URL;
  deadline: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  bytes: number;
}

async function request(
  context: RequestContext,
  path: string,
): Promise<{ response: Response; value: unknown }> {
  const current = context.now();
  if (current >= context.deadline) {
    throw new LexiconRegistryError(
      "Timed out waiting for the Lexicon API",
      "Timeout",
    );
  }
  const url = new URL(path, `${context.api.toString()}/`);
  const response = await context.fetcher(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(Math.max(1, context.deadline - current)),
  });
  if (response.url && new URL(response.url).origin !== url.origin) {
    throw new LexiconRegistryError(
      "Lexicon API redirected to another origin",
      "UnexpectedRedirect",
      response.status,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new LexiconRegistryError(
      `Lexicon API refused redirect (${response.status})`,
      "UnexpectedRedirect",
      response.status,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new LexiconRegistryError(
      "Lexicon API response is too large",
      "ResponseTooLarge",
      response.status,
    );
  }
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new LexiconRegistryError(
      "Lexicon API response is too large",
      "ResponseTooLarge",
      response.status,
    );
  }
  context.bytes += bytes;
  if (context.bytes > MAX_IMPORT_BYTES) {
    throw new LexiconRegistryError(
      "Lexicon import exceeds the total response size limit",
      "ResponseTooLarge",
    );
  }
  if (text.length === 0) return { response, value: null };
  try {
    return { response, value: JSON.parse(text) as unknown };
  } catch {
    throw new LexiconRegistryError(
      "Lexicon API returned invalid JSON",
      "InvalidResponse",
      response.status,
    );
  }
}

function createContext(options: RegistryClientOptions): RequestContext {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Lexicon API timeout must be positive");
  }
  return {
    fetcher: options.fetcher ?? fetch,
    api: normalizeApi(options.api ?? DEFAULT_LEXICON_API),
    deadline: now() + timeoutMs,
    now,
    sleep: options.sleep ?? defaultSleep,
    bytes: 0,
  };
}

function readinessError(page: PrefixPage): LexiconRegistryError | null {
  if (page.verification.settled && !page.verification.allVerified) {
    return new LexiconRegistryError(
      `Lexicon prefix verification failed: ${page.verification.unresolved} unresolved, ${page.verification.invalid} invalid`,
      "IncompleteVerification",
    );
  }
  if (page.indexing.settled && !page.indexing.complete) {
    return new LexiconRegistryError(
      `Lexicon catalog indexing is incomplete: ${page.indexing.backfillsExhausted} backfills exhausted`,
      "IncompleteIndexing",
    );
  }
  return null;
}

async function waitBeforeRetry(
  context: RequestContext,
  milliseconds = 500,
): Promise<void> {
  const remaining = context.deadline - context.now();
  if (remaining <= 0) {
    throw new LexiconRegistryError(
      "Timed out waiting for the Lexicon API",
      "Timeout",
    );
  }
  await context.sleep(Math.min(milliseconds, remaining));
}

async function getPrefixPage(
  context: RequestContext,
  prefix: string,
  cursor?: string,
): Promise<PrefixPage | "snapshot-changed"> {
  const params = new URLSearchParams({
    prefix,
    limit: String(DEFAULT_LIMIT),
    refresh: "true",
  });
  if (cursor) params.set("cursor", cursor);
  const { response, value } = await request(
    context,
    `/lexicons?${params.toString()}`,
  );
  if (response.status === 409) {
    const body = value as ErrorBody | null;
    if (body?.error === "SnapshotChanged") return "snapshot-changed";
  }
  if (!response.ok) {
    const body = value as ErrorBody | null;
    throw new LexiconRegistryError(
      `Lexicon prefix request failed: ${body?.error ?? response.status}`,
      body?.error ?? "RequestFailed",
      response.status,
    );
  }
  return parsePrefixPage(value, prefix, context.now());
}

export async function importLexiconPrefix(
  prefix: string,
  options: RegistryClientOptions = {},
): Promise<PrefixImport> {
  if (
    !prefix ||
    prefix.length > 317 ||
    !/^[A-Za-z0-9.-]+$/.test(prefix) ||
    prefix.startsWith(".") ||
    prefix.includes("..")
  ) {
    throw new TypeError("prefix must be a non-empty NSID prefix");
  }
  const context = createContext(options);
  const allowPartial = options.allowPartial === true;

  for (let restart = 0; restart < MAX_SNAPSHOT_RESTARTS; restart++) {
    let first: PrefixPage;
    while (true) {
      const result = await getPrefixPage(context, prefix);
      if (result === "snapshot-changed") {
        await waitBeforeRetry(context, 100);
        continue;
      }
      first = result;
      if (allowPartial) break;
      const failure = readinessError(first);
      if (failure) throw failure;
      if (first.verification.allVerified && first.indexing.complete) break;
      await waitBeforeRetry(context);
    }

    const documents = new Map<string, VerifiedLexiconDocument>();
    const addPage = (page: PrefixPage) => {
      if (page.snapshot !== first.snapshot) {
        throw new LexiconRegistryError(
          "Lexicon API changed snapshots without rejecting the cursor",
          "SnapshotChanged",
        );
      }
      for (const document of page.lexicons) {
        const existing = documents.get(document.id);
        if (existing && existing.cid !== document.cid) {
          throw new LexiconRegistryError(
            `Lexicon ${document.id} changed inside one snapshot`,
            "SnapshotChanged",
          );
        }
        documents.set(document.id, document);
      }
      if (documents.size > MAX_IMPORT_DOCUMENTS) {
        throw new LexiconRegistryError(
          `Lexicon prefix exceeds ${MAX_IMPORT_DOCUMENTS} documents`,
          "TooManyDocuments",
        );
      }
    };
    addPage(first);

    let cursor = first.cursor;
    let changed = false;
    while (cursor) {
      const result = await getPrefixPage(context, prefix, cursor);
      if (result === "snapshot-changed") {
        changed = true;
        break;
      }
      addPage(result);
      cursor = result.cursor;
    }
    if (changed) continue;

    return {
      api: context.api.origin,
      prefix,
      snapshot: first.snapshot,
      partial:
        !first.verification.allVerified || !first.indexing.complete,
      verification: first.verification,
      indexing: first.indexing,
      documents: [...documents.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
  }

  throw new LexiconRegistryError(
    "Lexicon prefix changed too often while it was being imported",
    "SnapshotChanged",
  );
}

function retryDelay(
  response: Response,
  body: ErrorBody,
  now: number,
): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 5_000);
  }
  const retryAt = body.retryAt ? Date.parse(body.retryAt) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > now) {
    return Math.min(retryAt - now, 5_000);
  }
  return 500;
}

export async function fetchExactLexicon(
  nsid: string,
  options: RegistryClientOptions = {},
): Promise<VerifiedLexiconDocument> {
  if (!isNsid(nsid)) throw new TypeError(`invalid Lexicon NSID: ${nsid}`);
  const context = createContext(options);

  while (true) {
    const { response, value } = await request(
      context,
      `/lexicons/${encodeURIComponent(nsid)}?refresh=true`,
    );
    if (response.status === 200) {
      return parseVerifiedDocument(value, context.now());
    }
    const body = (value ?? {}) as ErrorBody;
    if (response.status === 202 || response.status === 503) {
      await waitBeforeRetry(
        context,
        retryDelay(response, body, context.now()),
      );
      continue;
    }
    const code = body.error ?? "RequestFailed";
    throw new LexiconRegistryError(
      `Could not resolve Lexicon ${nsid}: ${code}`,
      code,
      response.status,
    );
  }
}
