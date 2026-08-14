import { isDid, isNsid } from "@atcute/lexicons/syntax";
import type { ContrailConfig } from "./core/types.js";
import {
  getCollectionMethods,
  nsidForShortName,
  resolveConfig,
} from "./core/types.js";

export interface PublicServiceOptions {
  /** Canonical public HTTPS origin, for example `https://api.example.com`. */
  endpoint: string;
  /** Permit plain HTTP only on a loopback host for local development. */
  allowInsecureHttp?: boolean;
}

export interface PublicServiceCollection {
  alias: string;
  nsid: string;
  methods: string[];
  queryable: string[];
  searchable: string[];
  relations: string[];
  references: string[];
}

export interface PublicServiceProtectedMethod {
  id: string;
  type: "query" | "procedure";
}

export interface PublicServiceAuthContract {
  type: "atproto-service-auth";
  audience: string;
  methods: PublicServiceProtectedMethod[];
}

export interface PublicContract {
  format: "contrail.contract";
  version: 1;
  namespace: string;
  collections: PublicServiceCollection[];
  methods: string[];
  serviceAuth?: PublicServiceAuthContract | null;
  lexiconDigest: string;
}

export interface PublicServiceManifest {
  format: "contrail.service";
  version: 1;
  endpoint: string;
  namespace: string;
  contract: { digest: string };
  lexicons: { url: string; digest: string };
  status: { url: string };
  collections: PublicServiceCollection[];
  methods: string[];
  serviceAuth?: PublicServiceAuthContract | null;
}

export interface LexiconDocument {
  lexicon?: number;
  id: string;
  [key: string]: unknown;
}

export interface PublicServiceDescription {
  endpoint: string;
  lexicons: LexiconDocument[];
  manifest: PublicServiceManifest;
  canonicalLexicons: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizePublicServiceEndpoint(
  value: string,
  options: { allowInsecureHttp?: boolean } = {},
): string {
  const url = new URL(value);
  const insecureLoopback =
    options.allowInsecureHttp === true &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !insecureLoopback) {
    throw new Error(
      options.allowInsecureHttp
        ? "public service endpoint must use HTTPS or loopback HTTP"
        : "public service endpoint must use HTTPS",
    );
  }
  if (url.username || url.password) {
    throw new Error("public service endpoint must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "public service endpoint must be an origin without a path, query, or fragment",
    );
  }
  return url.origin;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = normalizeJson(child);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function normalizeLexiconDocuments(
  values: readonly object[],
): LexiconDocument[] {
  const byId = new Map<string, LexiconDocument>();
  for (const value of values) {
    const id = (value as { id?: unknown }).id;
    if (typeof id !== "string" || !isNsid(id)) {
      throw new Error("public service lexicons must each have a valid NSID id");
    }
    if (byId.has(id)) {
      throw new Error(`duplicate public service lexicon: ${id}`);
    }
    byId.set(id, value as LexiconDocument);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function publicCollections(config: ContrailConfig): PublicServiceCollection[] {
  return Object.keys(config.collections)
    .sort()
    .map((alias) => {
      const collection = config.collections[alias]!;
      const standardMethods = getCollectionMethods(collection).map(
        (method) => `${config.namespace}.${alias}.${method}`,
      );
      const customMethods = [
        ...Object.keys(collection.queries ?? {}),
        ...Object.keys(collection.pipelineQueries ?? {}),
      ].map((method) => `${config.namespace}.${alias}.${method}`);
      return {
        alias,
        nsid: nsidForShortName(config, alias) ?? alias,
        methods: [...new Set([...standardMethods, ...customMethods])].sort(),
        queryable: Object.keys(collection.queryable ?? {}).sort(),
        searchable:
          collection.searchable === false
            ? []
            : [...(collection.searchable ?? [])].sort(),
        relations: Object.keys(collection.relations ?? {}).sort(),
        references: Object.keys(collection.references ?? {}).sort(),
      };
    });
}

function publicTopLevelMethods(config: ContrailConfig): string[] {
  const methods = [`${config.namespace}.getCursor`];
  if ((config.profiles?.length ?? 0) > 0) {
    methods.push(`${config.namespace}.getProfile`);
  }
  if (config.feeds && Object.keys(config.feeds).length > 0) {
    methods.push(`${config.namespace}.getFeed`);
  }
  return methods;
}

function publicServiceAuth(
  config: ContrailConfig,
): PublicServiceAuthContract | null {
  if (!config.serviceAuth || config.serviceAuth.methods.length === 0)
    return null;
  const methods = config.serviceAuth.methods
    .map((method): PublicServiceProtectedMethod =>
      method === "getFeed"
        ? { id: `${config.namespace}.getFeed`, type: "query" }
        : { id: `${config.namespace}.notifyOfUpdate`, type: "procedure" },
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    type: "atproto-service-auth",
    audience: config.serviceAuth.audience,
    methods,
  };
}

export function createPublicContract(
  config: ContrailConfig,
  lexiconDigest: string,
): PublicContract {
  const resolved = resolveConfig(config);
  const collections = publicCollections(resolved);
  const serviceAuth = publicServiceAuth(resolved);
  const protectedMethods = new Set(
    serviceAuth?.methods.map((method) => method.id) ?? [],
  );
  const methods = [
    ...publicTopLevelMethods(resolved),
    ...collections.flatMap((collection) => collection.methods),
  ].filter((method) => !protectedMethods.has(method));
  return {
    format: "contrail.contract",
    version: 1,
    namespace: resolved.namespace,
    collections,
    methods: [...new Set(methods)].sort(),
    serviceAuth,
    lexiconDigest,
  };
}

export async function digestPublicContract(
  contract: PublicContract,
): Promise<string> {
  return sha256(canonicalJson(contract));
}

export function validateContractLexicons(
  contract: PublicContract,
  values: readonly object[],
): LexiconDocument[] {
  const lexicons = normalizeLexiconDocuments(values);
  if (lexicons.length === 0) {
    throw new Error("public service requires a non-empty Lexicon bundle");
  }
  const byId = new Map(lexicons.map((document) => [document.id, document]));
  for (const method of contract.methods) {
    const document = byId.get(method) as
      { defs?: { main?: { type?: unknown } } } | undefined;
    if (document?.defs?.main?.type !== "query") {
      throw new Error(
        `public method requires a matching query Lexicon: ${method}`,
      );
    }
  }
  for (const method of contract.serviceAuth?.methods ?? []) {
    const document = byId.get(method.id) as
      { defs?: { main?: { type?: unknown } } } | undefined;
    if (document?.defs?.main?.type !== method.type) {
      throw new Error(
        `protected method requires a matching ${method.type} Lexicon: ${method.id}`,
      );
    }
  }
  return lexicons;
}

function assertPublicServiceSource(config: ContrailConfig): void {
  if (!config.orderedSource) {
    throw new Error(
      "public service mode requires orderedSource so getCursor has a durable continuity identity",
    );
  }
}

export function validatePublicServiceLexicons(
  config: ContrailConfig,
  values: readonly object[],
): LexiconDocument[] {
  assertPublicServiceSource(config);
  const placeholderDigest = `sha256:${"0".repeat(64)}`;
  return validateContractLexicons(
    createPublicContract(config, placeholderDigest),
    values,
  );
}

export async function digestLexiconDocuments(
  values: readonly object[],
): Promise<{
  lexicons: LexiconDocument[];
  canonicalLexicons: string;
  digest: string;
}> {
  const lexicons = normalizeLexiconDocuments(values);
  const canonicalLexicons = canonicalJson({ lexicons });
  return {
    lexicons,
    canonicalLexicons,
    digest: await sha256(canonicalLexicons),
  };
}

export async function describePublicService(
  config: ContrailConfig,
  options: PublicServiceOptions,
  values: readonly object[],
): Promise<PublicServiceDescription> {
  assertPublicServiceSource(config);
  const endpoint = normalizePublicServiceEndpoint(options.endpoint, options);
  const {
    lexicons,
    canonicalLexicons,
    digest: lexiconDigest,
  } = await digestLexiconDocuments(values);
  const contract = createPublicContract(config, lexiconDigest);
  validateContractLexicons(contract, lexicons);
  const manifest: PublicServiceManifest = {
    format: "contrail.service",
    version: 1,
    endpoint,
    namespace: contract.namespace,
    contract: { digest: await digestPublicContract(contract) },
    lexicons: {
      url: `${endpoint}/lexicons/${lexiconDigest}`,
      digest: lexiconDigest,
    },
    status: { url: `${endpoint}/status` },
    collections: contract.collections,
    methods: contract.methods,
    serviceAuth: contract.serviceAuth,
  };
  return { endpoint, lexicons, manifest, canonicalLexicons };
}

function uniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

export function contractFromManifest(
  manifest: PublicServiceManifest,
): PublicContract {
  return {
    format: "contrail.contract",
    version: 1,
    namespace: manifest.namespace,
    collections: manifest.collections,
    methods: manifest.methods,
    serviceAuth: manifest.serviceAuth,
    lexiconDigest: manifest.lexicons.digest,
  };
}

export function validateManifestContract(
  manifest: PublicServiceManifest,
  values: readonly object[],
): LexiconDocument[] {
  if (!isPublicServiceAuthContract(manifest.serviceAuth)) {
    throw new Error("service manifest contains invalid service auth");
  }
  if (!uniqueStrings(manifest.methods)) {
    throw new Error("service manifest contains duplicate methods");
  }
  const aliases = manifest.collections.map((collection) => collection.alias);
  if (!uniqueStrings(aliases)) {
    throw new Error("service manifest contains duplicate collection aliases");
  }
  const prefix = `${manifest.namespace}.`;
  if (manifest.methods.some((method) => !method.startsWith(prefix))) {
    throw new Error("service manifest method is outside its namespace");
  }
  const protectedMethods = manifest.serviceAuth?.methods ?? [];
  const protectedIds = protectedMethods.map((method) => method.id);
  if (!uniqueStrings(protectedIds)) {
    throw new Error("service manifest contains duplicate protected methods");
  }
  if (protectedIds.some((method) => !method.startsWith(prefix))) {
    throw new Error(
      "service manifest protected method is outside its namespace",
    );
  }
  if (protectedIds.some((method) => manifest.methods.includes(method))) {
    throw new Error(
      "service manifest method cannot be both anonymous and protected",
    );
  }
  const advertised = new Set(manifest.methods);
  for (const collection of manifest.collections) {
    if (!uniqueStrings(collection.methods)) {
      throw new Error(
        `service manifest collection ${collection.alias} contains duplicate methods`,
      );
    }
    for (const method of collection.methods) {
      if (!advertised.has(method)) {
        throw new Error(
          `collection ${collection.alias} advertises an unknown method: ${method}`,
        );
      }
    }
  }
  return validateContractLexicons(contractFromManifest(manifest), values);
}

function isPublicServiceAuthContract(
  value: unknown,
): value is PublicServiceAuthContract | null | undefined {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const auth = value as Partial<PublicServiceAuthContract>;
  return (
    auth.type === "atproto-service-auth" &&
    typeof auth.audience === "string" &&
    isDid(auth.audience) &&
    Array.isArray(auth.methods) &&
    auth.methods.every(
      (method) =>
        !!method &&
        typeof method === "object" &&
        typeof method.id === "string" &&
        isNsid(method.id) &&
        (method.type === "query" || method.type === "procedure"),
    )
  );
}

export function isPublicServiceManifest(
  value: unknown,
): value is PublicServiceManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<PublicServiceManifest>;
  const digest = /^sha256:[0-9a-f]{64}$/;
  if (
    manifest.format !== "contrail.service" ||
    manifest.version !== 1 ||
    typeof manifest.endpoint !== "string" ||
    typeof manifest.namespace !== "string" ||
    !isNsid(`${manifest.namespace}.method`) ||
    typeof manifest.contract?.digest !== "string" ||
    !digest.test(manifest.contract.digest) ||
    typeof manifest.lexicons?.url !== "string" ||
    typeof manifest.lexicons?.digest !== "string" ||
    !digest.test(manifest.lexicons.digest) ||
    typeof manifest.status?.url !== "string" ||
    !Array.isArray(manifest.collections) ||
    !Array.isArray(manifest.methods) ||
    !isPublicServiceAuthContract(manifest.serviceAuth) ||
    !manifest.methods.every(
      (method) => typeof method === "string" && isNsid(method),
    )
  ) {
    return false;
  }
  return manifest.collections.every((collection) => {
    if (!collection || typeof collection !== "object") return false;
    const entry = collection as Partial<PublicServiceCollection>;
    return (
      typeof entry.alias === "string" &&
      entry.alias.length > 0 &&
      typeof entry.nsid === "string" &&
      isNsid(entry.nsid) &&
      Array.isArray(entry.methods) &&
      entry.methods.every(
        (method) => typeof method === "string" && isNsid(method),
      ) &&
      [
        entry.queryable,
        entry.searchable,
        entry.relations,
        entry.references,
      ].every(
        (items) =>
          Array.isArray(items) &&
          items.every((item) => typeof item === "string"),
      )
    );
  });
}
