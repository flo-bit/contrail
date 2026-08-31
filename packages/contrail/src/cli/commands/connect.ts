import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { isNsid } from "@atcute/lexicons/syntax";
import type { CAC } from "cac";
import {
  describePublicService,
  digestLexiconDocuments,
  isPublicServiceAuthContract,
  isPublicServiceManifest,
  normalizePublicServiceEndpoint,
  validateServiceManifest,
  type LexiconDocument,
  type PublicServiceAuthContract,
  type PublicServiceManifest,
} from "../../public-service.js";
import {
  configProjectRoot,
  findConfigFile,
  loadConfig,
} from "../../cli-config.js";
import type { ContrailConfig } from "../../core/types.js";
import {
  defaultConsumerLexiconRoot,
  prepareDevLexicons,
} from "../dev-lexicons.js";
import { generateLexiconTypesWithAtcute } from "../atcute.js";
import { confirmUnresolvedLexicons } from "../shared.js";

const MAX_DISCOVERY_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const LEXICON_CONFIG_NAMES = [
  "lex.config.js",
  "lex.config.mjs",
  "lex.config.cjs",
  "lex.config.ts",
  "lex.config.mts",
  "lex.config.cts",
];

interface ConnectOptions {
  root: string;
  out: string;
  lock: string;
  client: string;
  clientTypes: string;
  generate?: boolean;
  skipClient?: boolean;
  update?: boolean;
  allowInsecureHttp?: boolean;
  yes?: boolean;
}

export interface ProviderDefinition {
  endpoint: string;
  namespace: string;
  lexiconDigest: string;
  methods: string[];
  collections: string[];
  serviceAuth: PublicServiceAuthContract | null;
  lexiconRoot: string;
  /** Explicit loopback-only HTTP exception for a local development provider. */
  allowInsecureHttp?: true;
}

export interface ProviderLock extends ProviderDefinition {
  format: "contrail.provider-lock";
  version: 2;
}

async function readProviderLock(path: string): Promise<ProviderLock | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("existing Contrail provider lock is not valid JSON");
  }
  const lock = value as Partial<ProviderLock>;
  if (
    !value ||
    typeof value !== "object" ||
    lock.format !== "contrail.provider-lock" ||
    lock.version !== 2 ||
    "contractDigest" in lock ||
    typeof lock.endpoint !== "string" ||
    typeof lock.lexiconRoot !== "string" ||
    !("serviceAuth" in lock) ||
    !isPublicServiceAuthContract(lock.serviceAuth) ||
    (lock.allowInsecureHttp !== undefined && lock.allowInsecureHttp !== true)
  ) {
    if ((value as { version?: unknown }).version === 1) {
      throw new Error(
        "existing Contrail provider lock uses unsupported version 1; remove it and reconnect",
      );
    }
    if (
      lock.format === "contrail.provider-lock" &&
      lock.version === 2 &&
      "serviceAuth" in lock &&
      !isPublicServiceAuthContract(lock.serviceAuth)
    ) {
      throw new Error(
        "existing Contrail provider lock predates exact service-auth audiences; remove it, reconnect, and reauthorize OAuth",
      );
    }
    throw new Error("existing Contrail provider lock is malformed");
  }
  return lock as ProviderLock;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      `${label} request failed: ${response.status} ${response.statusText}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_DISCOVERY_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DISCOVERY_BYTES} bytes`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DISCOVERY_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DISCOVERY_BYTES} bytes`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string | URL,
  label: string,
  timeoutMs: number,
): Promise<unknown> {
  const requested = new URL(url);
  const response = await fetcher(requested, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.url && new URL(response.url).origin !== requested.origin) {
    throw new Error(`${label} redirected to a different origin`);
  }
  return readJson(response, label);
}

function resolveInsideRoot(
  root: string,
  value: string,
  options: { allowRoot?: boolean } = {},
): string {
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (
    (!options.allowRoot && rel === "") ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`path must stay inside the consumer project: ${value}`);
  }
  return target;
}

function lexiconPath(root: string, id: string): string {
  if (!isNsid(id)) throw new Error(`invalid Lexicon NSID: ${id}`);
  return resolve(root, ...id.split(".")) + ".json";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function protectedMethodIds(provider: ProviderDefinition): string[] {
  return (provider.serviceAuth?.methods ?? []).map(({ id }) => id).sort();
}

function formatStringArray(
  values: readonly string[],
  indentation: number,
): string {
  if (values.length === 0) return "[]";
  const items = values
    .map((value) => `${" ".repeat(indentation + 2)}${JSON.stringify(value)},`)
    .join("\n");
  return `[\n${items}\n${" ".repeat(indentation)}]`;
}

const GENERATED_LEXICON_CONFIG_HEADER =
  "// Generated by `contrail connect`. Re-run the command to update; do not edit.\n";

/** Create a dependency-free Atcute config containing the connected service
 * metadata. Unmarked JavaScript or TypeScript configs remain consumer-owned. */
export async function ensureConsumerLexiconConfig(options: {
  root: string;
  out: string;
  types?: string;
  /** API definition whose Lexicons and collections are generated. */
  api: ProviderDefinition;
  /** Runtime deployment target. Defaults to the API source itself. */
  target?: ProviderDefinition;
}): Promise<{ path: string; created: boolean; updated: boolean }> {
  const root = resolve(options.root);
  let path = join(root, "lex.config.js");
  for (const name of LEXICON_CONFIG_NAMES) {
    const candidate = join(root, name);
    if (await exists(candidate)) {
      path = candidate;
      break;
    }
  }

  const lexiconRoot = resolveInsideRoot(root, options.out);
  const patternRoot = relative(root, lexiconRoot).replaceAll("\\", "/");
  const typesIndex = resolveInsideRoot(
    root,
    options.types ?? "src/contrail/types/index.ts",
  );
  const typesRoot = relative(root, dirname(typesIndex)).replaceAll("\\", "/");
  const target = options.target ?? options.api;
  // Omit the service-auth keys entirely when the provider has none. This block
  // is reference material consumers paste into `createPublicServiceClient`, and
  // a wall of nulls reads like a broken contract rather than an anonymous one.
  const serviceAuthFields = target.serviceAuth
    ? `\n    serviceDid: ${JSON.stringify(target.serviceAuth.serviceDid)},` +
      `\n    serviceAudience: ${JSON.stringify(target.serviceAuth.audience)},` +
      `\n    scope: ${JSON.stringify(target.serviceAuth.scope)},` +
      `\n    protectedMethods: ${formatStringArray(protectedMethodIds(target), 4)},`
    : "";
  const source = `${GENERATED_LEXICON_CONFIG_HEADER}export default {\n  contrail: {\n    endpoint: ${JSON.stringify(target.endpoint)},${serviceAuthFields}\n    collections: ${formatStringArray(target.collections, 4)},\n  },\n  generate: {\n    files: [${JSON.stringify(`${patternRoot}/**/*.json`)}],\n    outdir: ${JSON.stringify(`${typesRoot}/`)},\n  },\n};\n`;

  if (await exists(path)) {
    const current = await readFile(path, "utf8");
    if (
      !current.startsWith(GENERATED_LEXICON_CONFIG_HEADER) ||
      current === source
    ) {
      return { path, created: false, updated: false };
    }
    const stagedDirectory = await mkdtemp(
      join(dirname(path), ".contrail-lex-"),
    );
    const staged = join(stagedDirectory, basename(path));
    try {
      await writeFile(staged, source);
      await rename(staged, path);
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true });
    }
    return { path, created: false, updated: true };
  }

  try {
    await writeFile(path, source, { flag: "wx" });
    return { path, created: true, updated: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { path, created: false, updated: false };
    }
    throw error;
  }
}

const GENERATED_CLIENT_HEADER =
  "// Generated by `contrail connect`. Re-run the command to update; do not edit.\n";

/** Create the small provider-specific module used by application and OAuth
 * setup code. Unmarked TypeScript or JavaScript modules remain consumer-owned. */
export async function ensureConsumerClientModule(options: {
  root: string;
  file?: string;
  types?: string;
  /** API definition used for generated methods, collections, and types. */
  api: ProviderDefinition;
  /** Default runtime deployment. Defaults to the API source itself. */
  target?: ProviderDefinition;
  /** Local-development notification method not advertised as a public query. */
  notifyMethod?: string;
}): Promise<{ path: string; created: boolean; updated: boolean }> {
  const root = resolve(options.root);
  const requested = options.file ?? "src/contrail/index.ts";
  const defaultNames = ["src/contrail/index.ts", "src/contrail/index.js"];
  let selected = requested;
  if (defaultNames.includes(requested)) {
    for (const name of defaultNames) {
      if (await exists(join(root, name))) {
        selected = name;
        break;
      }
    }
  }
  if (!/\.(?:ts|js)$/.test(selected)) {
    throw new Error("Contrail client module must end in .ts or .js");
  }

  const path = resolveInsideRoot(root, selected);
  const isTypeScript = selected.endsWith(".ts");
  let generatedImport = "";
  let generatedTypeImport = "";
  if (isTypeScript) {
    const types = resolveInsideRoot(
      root,
      options.types ?? "src/contrail/types/index.ts",
    );
    let specifier = relative(dirname(path), types).replaceAll("\\", "/");
    specifier = specifier.replace(/\.(?:ts|js)$/, ".js");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    generatedImport = `import type {} from ${JSON.stringify(specifier)};\n`;
    generatedTypeImport =
      'import type { PublicServiceClientOptions } from "@atmo-dev/contrail/client";\n';
  }
  const target = options.target ?? options.api;
  const targetServiceDid = target.serviceAuth?.serviceDid;
  const targetServiceAudience = target.serviceAuth?.audience;
  const targetScope = target.serviceAuth?.scope;
  const apiProtectedMethods = protectedMethodIds(options.api);
  const configuredNotifyMethod =
    options.notifyMethod ??
    [...options.api.methods, ...apiProtectedMethods].find(
      (method) => method === `${options.api.namespace}.notifyOfUpdate`,
    );
  const serviceMethods = [
    ...new Set([
      ...options.api.methods,
      ...apiProtectedMethods,
      ...(configuredNotifyMethod ? [configuredNotifyMethod] : []),
    ]),
  ].sort();
  const targetProtectedMethods = protectedMethodIds(target);
  const targetMethods = [
    ...new Set([...target.methods, ...targetProtectedMethods]),
  ].sort();
  const notifyMethod = configuredNotifyMethod;
  const targetNotifyMethod = targetMethods.find(
    (method) => method === `${target.namespace}.notifyOfUpdate`,
  );
  const constAssertion = isTypeScript ? " as const" : "";
  const targetType = isTypeScript
    ? `\nexport type ContrailTarget = Pick<\n  PublicServiceClientOptions,\n  "endpoint" | "allowInsecureHttp" | "serviceDid" | "serviceAudience" | "scope" | "protectedMethods" | "serviceMethods" | "collections"\n> & {\n  notifyMethod?: PublicServiceClientOptions["notifyMethod"] | null;\n};\n`
    : "";
  const targetAnnotation = isTypeScript ? ": ContrailTarget" : "";
  const source = `${GENERATED_CLIENT_HEADER}import { createPublicServiceClient } from "@atmo-dev/contrail/client";\n${generatedTypeImport}${generatedImport}\nexport const contrailApi = {\n  namespace: ${JSON.stringify(options.api.namespace)},\n  serviceMethods: ${formatStringArray(serviceMethods, 2)},\n  protectedMethods: ${formatStringArray(apiProtectedMethods, 2)},\n  collections: ${formatStringArray(options.api.collections, 2)},\n  notifyMethod: ${JSON.stringify(notifyMethod ?? null)},\n}${constAssertion};\n\nexport const contrailTarget = {\n  endpoint: ${JSON.stringify(target.endpoint)},${target.allowInsecureHttp ? "\n  allowInsecureHttp: true," : ""}${targetServiceDid && targetServiceAudience && targetScope ? `\n  serviceDid: ${JSON.stringify(targetServiceDid)},\n  serviceAudience: ${JSON.stringify(targetServiceAudience)},\n  scope: ${JSON.stringify(targetScope)},\n  protectedMethods: ${formatStringArray(targetProtectedMethods, 2)},` : ""}\n  serviceMethods: ${formatStringArray(targetMethods, 2)},\n  collections: ${formatStringArray(target.collections, 2)},\n  notifyMethod: ${JSON.stringify(targetNotifyMethod ?? null)},\n}${constAssertion};\n\nexport const contrailMethods = contrailTarget.serviceMethods;\n${targetType}\nexport function createContrailClient(target${targetAnnotation} = contrailTarget) {\n  const { notifyMethod: targetNotifyMethod, ...runtimeTarget } = target;\n  const notifyMethod =\n    targetNotifyMethod === undefined\n      ? contrailApi.notifyMethod\n      : targetNotifyMethod;\n  return createPublicServiceClient({\n    ...runtimeTarget,\n    serviceMethods: target.serviceMethods ?? contrailApi.serviceMethods,\n    collections: target.collections ?? contrailApi.collections,\n    ...(notifyMethod ? { notifyMethod } : {}),\n  });\n}\n\nexport function createLocalContrailClient(\n  endpoint = "http://127.0.0.1:8787",\n) {\n  return createContrailClient({\n    endpoint,\n    allowInsecureHttp: true,\n    serviceMethods: contrailApi.serviceMethods,\n    collections: contrailApi.collections,\n    notifyMethod: contrailApi.notifyMethod,\n  });\n}\n\nexport const contrail = createContrailClient();\n`;
  await mkdir(dirname(path), { recursive: true });

  if (await exists(path)) {
    const current = await readFile(path, "utf8");
    if (!current.startsWith(GENERATED_CLIENT_HEADER) || current === source) {
      return { path, created: false, updated: false };
    }
    const stagedDirectory = await mkdtemp(
      join(dirname(path), ".contrail-client-"),
    );
    const staged = join(stagedDirectory, basename(path));
    try {
      await writeFile(staged, source);
      await rename(staged, path);
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true });
    }
    return { path, created: false, updated: true };
  }

  try {
    await writeFile(path, source, { flag: "wx" });
    return { path, created: true, updated: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { path, created: false, updated: false };
    }
    throw error;
  }
}

function allServiceMethods(lock: ProviderDefinition): string[] {
  return [
    ...new Set([
      ...lock.methods,
      ...(lock.serviceAuth?.methods.map(({ id }) => id) ?? []),
    ]),
  ].sort();
}

async function resolveConfigSource(
  source: string,
  consumerRoot: string,
): Promise<string> {
  const path = resolve(consumerRoot, source);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`Contrail source does not exist: ${source}`);
  }
  if (info.isDirectory()) {
    const config = findConfigFile(path);
    if (!config) {
      throw new Error(`Could not find a Contrail config under ${source}`);
    }
    return config;
  }
  if (!info.isFile()) {
    throw new Error(
      `Contrail source must be a config file or directory: ${source}`,
    );
  }
  return path;
}

export async function replaceSourceLexicons(
  outputRoot: string,
  providerKey: string,
  lexicons: readonly LexiconDocument[],
): Promise<string> {
  await mkdir(outputRoot, { recursive: true });
  const providerRoot = resolveInsideRoot(outputRoot, providerKey);
  const stagedProvider = await mkdtemp(join(outputRoot, `.${providerKey}-`));
  const backupRoot = join(
    outputRoot,
    `.${providerKey}.backup-${process.pid}-${Date.now()}`,
  );
  let backedUp = false;
  let installed = false;
  try {
    for (const document of lexicons) {
      const path = lexiconPath(stagedProvider, document.id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
    }
    if (await exists(providerRoot)) {
      await rename(providerRoot, backupRoot);
      backedUp = true;
    }
    await rename(stagedProvider, providerRoot);
    installed = true;
    await rm(backupRoot, { recursive: true, force: true });
    backedUp = false;
  } catch (error) {
    if (installed) await rm(providerRoot, { recursive: true, force: true });
    if (backedUp && (await exists(backupRoot))) {
      await rename(backupRoot, providerRoot);
    }
    throw error;
  } finally {
    await rm(stagedProvider, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  }
  return providerRoot;
}

/** Compile an owned config into the same API artifacts as remote discovery.
 * This deliberately does not create or mutate the deployment provider lock. */
export async function connectConfigSource(options: {
  source: string;
  root: string;
  out: string;
  lock?: string;
  endpoint?: string;
  confirmUnresolvedLexicons?: (
    nsids: readonly string[],
  ) => boolean | Promise<boolean>;
}): Promise<{
  manifest: PublicServiceManifest;
  definition: ProviderDefinition;
  target: ProviderDefinition;
  config: ContrailConfig;
  configPath: string;
  written: number;
}> {
  const projectRoot = resolve(options.root);
  const configPath = await resolveConfigSource(options.source, projectRoot);
  const config = await loadConfig<ContrailConfig>(configPath);
  const sourceConfig: ContrailConfig = {
    ...config,
    notify: config.notify ?? true,
    orderedSource: config.orderedSource ?? {
      source: "jetstream",
      epoch: "contrail-local-jetstream-v2",
    },
  };
  const endpoint = normalizePublicServiceEndpoint(
    options.endpoint ?? "http://127.0.0.1:8787",
    { allowInsecureHttp: true },
  );
  const lockPath = resolveInsideRoot(
    projectRoot,
    options.lock ?? "contrail.lock.json",
  );
  const lockedTarget = await readProviderLock(lockPath);
  if (lockedTarget && lockedTarget.namespace !== sourceConfig.namespace) {
    throw new Error(
      `provider lock namespace ${lockedTarget.namespace} does not match source namespace ${sourceConfig.namespace}`,
    );
  }
  const workspaceRoot = join(projectRoot, ".contrail", "source");
  await mkdir(workspaceRoot, { recursive: true });
  const outputRoot = resolveInsideRoot(projectRoot, options.out);
  const providerKey = "source";
  const providerRoot = resolveInsideRoot(outputRoot, providerKey);
  const lexicons = await prepareDevLexicons(
    sourceConfig,
    projectRoot,
    workspaceRoot,
    providerRoot,
    configProjectRoot(configPath),
    { confirmUnresolved: options.confirmUnresolvedLexicons },
  );
  const description = await describePublicService(
    sourceConfig,
    { endpoint, allowInsecureHttp: true },
    lexicons,
  );
  await replaceSourceLexicons(outputRoot, providerKey, description.lexicons);

  const definition: ProviderDefinition = {
    endpoint,
    namespace: description.manifest.namespace,
    lexiconDigest: description.manifest.lexicons.digest,
    methods: [...description.manifest.methods].sort(),
    collections: [
      ...new Set(description.manifest.collections.map(({ nsid }) => nsid)),
    ].sort(),
    serviceAuth: description.manifest.serviceAuth ?? null,
    lexiconRoot: relative(projectRoot, providerRoot),
    allowInsecureHttp: true,
  };
  const localTarget: ProviderDefinition = {
    ...definition,
    methods: [
      ...new Set([
        ...allServiceMethods(definition),
        ...(sourceConfig.notify
          ? [`${sourceConfig.namespace}.notifyOfUpdate`]
          : []),
      ]),
    ].sort(),
    serviceAuth: null,
  };
  const target = lockedTarget ?? localTarget;
  return {
    manifest: description.manifest,
    definition,
    target,
    config: sourceConfig,
    configPath,
    written: description.lexicons.length,
  };
}

export async function connectPublicService(options: {
  endpoint: string;
  root: string;
  out: string;
  lock: string;
  fetcher?: typeof fetch;
  update?: boolean;
  /** Permit plain HTTP only for an explicitly selected loopback provider. */
  allowInsecureHttp?: boolean;
  /** @internal Stable provider directory for an auto-managed local connection. */
  providerKey?: string;
  /** @internal Shorter timeout for deterministic connection tests. */
  timeoutMs?: number;
}): Promise<{
  manifest: PublicServiceManifest;
  lock: ProviderLock;
  written: number;
}> {
  const endpoint = normalizePublicServiceEndpoint(options.endpoint, options);
  const projectRoot = resolve(options.root);
  const lockPath = resolveInsideRoot(projectRoot, options.lock);
  const outputRoot = resolveInsideRoot(projectRoot, options.out);
  const providerKey =
    options.providerKey ??
    new URL(endpoint).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  if (!/^[a-zA-Z0-9._-]+$/.test(providerKey)) {
    throw new Error("provider key must be one safe path segment");
  }
  const providerRoot = resolveInsideRoot(outputRoot, providerKey);
  const existingLock = await readProviderLock(lockPath);
  if (existingLock && !options.update) {
    throw new Error(
      "a Contrail provider lock already exists; rerun with --update",
    );
  }
  if (existingLock) {
    if (
      normalizePublicServiceEndpoint(existingLock.endpoint, {
        allowInsecureHttp: existingLock.allowInsecureHttp === true,
      }) !== endpoint
    ) {
      throw new Error(
        `provider lock targets ${existingLock.endpoint}; remove the existing connection before switching endpoints`,
      );
    }
    if (
      resolveInsideRoot(projectRoot, existingLock.lexiconRoot) !== providerRoot
    ) {
      throw new Error(
        `provider lock owns ${existingLock.lexiconRoot}; reuse its output path or remove the existing connection`,
      );
    }
  }
  const fetcher = options.fetcher ?? fetch;
  const manifestValue = await fetchJson(
    fetcher,
    `${endpoint}/.well-known/contrail`,
    "Contrail manifest",
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  if (!isPublicServiceManifest(manifestValue)) {
    throw new Error("response is not a supported Contrail service manifest");
  }
  const manifest = manifestValue;
  if (normalizePublicServiceEndpoint(manifest.endpoint, options) !== endpoint) {
    throw new Error(
      `manifest endpoint mismatch: expected ${endpoint}, received ${manifest.endpoint}`,
    );
  }
  const lexiconUrl = new URL(manifest.lexicons.url);
  const statusUrl = new URL(manifest.status.url);
  if (
    lexiconUrl.origin !== endpoint ||
    lexiconUrl.username !== "" ||
    lexiconUrl.password !== "" ||
    statusUrl.origin !== endpoint ||
    statusUrl.username !== "" ||
    statusUrl.password !== ""
  ) {
    throw new Error("manifest resource URLs must use the service origin");
  }
  const lexiconValue = await fetchJson(
    fetcher,
    lexiconUrl,
    "Contrail Lexicons",
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  const values = (lexiconValue as { lexicons?: unknown })?.lexicons;
  if (!Array.isArray(values)) {
    throw new Error("Lexicon response must contain a lexicons array");
  }
  const { lexicons, digest } = await digestLexiconDocuments(values as object[]);
  if (digest !== manifest.lexicons.digest) {
    throw new Error(
      `Lexicon digest mismatch: manifest=${manifest.lexicons.digest}, fetched=${digest}`,
    );
  }
  validateServiceManifest(manifest, lexicons);

  await mkdir(outputRoot, { recursive: true });
  const stagedProvider = await mkdtemp(join(outputRoot, `.${providerKey}-`));
  for (const document of lexicons) {
    const path = lexiconPath(stagedProvider, document.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  }

  const lock: ProviderLock = {
    format: "contrail.provider-lock",
    version: 2,
    endpoint,
    namespace: manifest.namespace,
    lexiconDigest: manifest.lexicons.digest,
    methods: [...manifest.methods].sort(),
    collections: [
      ...new Set(manifest.collections.map(({ nsid }) => nsid)),
    ].sort(),
    serviceAuth: manifest.serviceAuth ?? null,
    lexiconRoot: relative(projectRoot, providerRoot),
    ...(new URL(endpoint).protocol === "http:"
      ? { allowInsecureHttp: true as const }
      : {}),
  };
  const lockDirectory = dirname(lockPath);
  await mkdir(lockDirectory, { recursive: true });
  const stagedLockDirectory = await mkdtemp(
    join(lockDirectory, `.${basename(lockPath)}-`),
  );
  const stagedLock = join(stagedLockDirectory, basename(lockPath));
  await writeFile(stagedLock, `${JSON.stringify(lock, null, 2)}\n`);

  const backupRoot = join(
    outputRoot,
    `.${providerKey}.backup-${process.pid}-${Date.now()}`,
  );
  const backupLock = join(
    lockDirectory,
    `.${basename(lockPath)}.backup-${process.pid}-${Date.now()}`,
  );
  const hadProvider = await exists(providerRoot);
  const hadLock = await exists(lockPath);
  try {
    if (hadProvider) await rename(providerRoot, backupRoot);
    if (hadLock) await rename(lockPath, backupLock);
    await rename(stagedProvider, providerRoot);
    await rename(stagedLock, lockPath);
    await rm(backupRoot, { recursive: true, force: true });
    await rm(backupLock, { force: true });
  } catch (error) {
    await rm(providerRoot, { recursive: true, force: true });
    await rm(lockPath, { force: true });
    if (hadProvider && (await exists(backupRoot))) {
      await rename(backupRoot, providerRoot);
    }
    if (hadLock && (await exists(backupLock))) {
      await rename(backupLock, lockPath);
    }
    throw error;
  } finally {
    await rm(stagedProvider, { recursive: true, force: true });
    await rm(stagedLockDirectory, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
    await rm(backupLock, { force: true });
  }
  return { manifest, lock, written: lexicons.length };
}

function endpointSource(source: string): string | null {
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:"
      ? source
      : null;
  } catch {
    return null;
  }
}

export function registerConnect(cli: CAC): void {
  cli
    .command(
      "connect <source>",
      "Generate a typed client from a Contrail config, directory, or deployment URL",
    )
    .option("--root <path>", "Consumer project root", {
      default: process.cwd(),
    })
    .option("--out <path>", "Provider-owned Lexicon storage relative to root", {
      default: "src/contrail/lexicons",
    })
    .option("--lock <path>", "Provider lock file relative to root", {
      default: "contrail.lock.json",
    })
    .option("--client <path>", "Generated client module (.ts or .js)", {
      default: "src/contrail/index.ts",
    })
    .option(
      "--client-types <path>",
      "Generated Lexicon index imported by a TypeScript client",
      {
        default: "src/contrail/types/index.ts",
      },
    )
    .option("--skip-client", "Do not create a provider client module")
    .option(
      "--allow-insecure-http",
      "Permit HTTP only for a loopback development provider",
    )
    .option(
      "--update",
      "Replace an existing deployment lock and owned Lexicons",
    )
    .option(
      "--no-generate",
      "Resolve the API without generating types or a client module",
    )
    .option(
      "--yes, -y",
      "Continue when configured Lexicons cannot be resolved",
    )
    .action(async (source: string, options: ConnectOptions) => {
      const endpoint = endpointSource(source);
      let api: ProviderDefinition;
      let target: ProviderDefinition;
      let written: number;
      let notifyMethod: string | undefined;
      let lexiconRoot: string;

      if (endpoint) {
        const result = await connectPublicService({
          endpoint,
          root: options.root,
          out: options.out,
          lock: options.lock,
          update: options.update,
          allowInsecureHttp: options.allowInsecureHttp,
        });
        api = result.lock;
        target = result.lock;
        written = result.written;
        lexiconRoot = options.out;
        console.log(
          `connected ${result.lock.endpoint}: ${written} Lexicons, bundle ${result.lock.lexiconDigest}`,
        );
      } else {
        const result = await connectConfigSource({
          source,
          root: options.root,
          out: options.out,
          lock: options.lock,
          confirmUnresolvedLexicons: (nsids) =>
            confirmUnresolvedLexicons(nsids, options.yes === true),
        });
        api = result.definition;
        target = result.target;
        written = result.written;
        lexiconRoot = result.definition.lexiconRoot;
        notifyMethod = result.config.notify
          ? `${result.config.namespace}.notifyOfUpdate`
          : undefined;
        console.log(
          `connected source ${relative(resolve(options.root), result.configPath)}: ` +
            `${written} Lexicons, bundle ${api.lexiconDigest} (deployment lock unchanged)`,
        );
      }

      if (options.generate !== false) {
        const config = await ensureConsumerLexiconConfig({
          root: options.root,
          out: lexiconRoot,
          types: options.clientTypes,
          api,
          target,
        });
        if (config.created) {
          console.log(
            `created ${relative(resolve(options.root), config.path)}`,
          );
        } else if (config.updated) {
          console.log(
            `updated ${relative(resolve(options.root), config.path)}`,
          );
        }
        generateLexiconTypesWithAtcute(resolve(options.root));
        if (!options.skipClient) {
          const client = await ensureConsumerClientModule({
            root: options.root,
            file: options.client,
            types: options.clientTypes,
            api,
            target,
            notifyMethod,
          });
          if (client.created) {
            console.log(
              `created ${relative(resolve(options.root), client.path)}`,
            );
          } else if (client.updated) {
            console.log(
              `updated ${relative(resolve(options.root), client.path)}`,
            );
          }
        }
      }
    });
}
