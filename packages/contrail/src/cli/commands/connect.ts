import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
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
  contractFromManifest,
  digestLexiconDocuments,
  digestPublicContract,
  isPublicServiceManifest,
  normalizePublicServiceEndpoint,
  validateManifestContract,
  type PublicServiceAuthContract,
  type PublicServiceManifest,
} from "../../public-service.js";
import { generateLexiconTypesWithAtcute } from "../atcute.js";

const MAX_DISCOVERY_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

interface ConnectOptions {
  root: string;
  out: string;
  lock: string;
  generate?: boolean;
  update?: boolean;
}

export interface ProviderLock {
  format: "contrail.provider-lock";
  version: 1;
  endpoint: string;
  namespace: string;
  contractDigest: string;
  lexiconDigest: string;
  methods: string[];
  serviceAuth: PublicServiceAuthContract | null;
  lexiconRoot: string;
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

export async function connectPublicService(options: {
  endpoint: string;
  root: string;
  out: string;
  lock: string;
  fetcher?: typeof fetch;
  update?: boolean;
  /** @internal Shorter timeout for deterministic connection tests. */
  timeoutMs?: number;
}): Promise<{
  manifest: PublicServiceManifest;
  lock: ProviderLock;
  written: number;
}> {
  const endpoint = normalizePublicServiceEndpoint(options.endpoint);
  const projectRoot = resolve(options.root);
  const lockPath = resolveInsideRoot(projectRoot, options.lock);
  if (!options.update) {
    try {
      await readFile(lockPath, "utf8");
      throw new Error(
        "a Contrail provider lock already exists; rerun with --update",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  if (normalizePublicServiceEndpoint(manifest.endpoint) !== endpoint) {
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
  validateManifestContract(manifest, lexicons);
  const contractDigest = await digestPublicContract(
    contractFromManifest(manifest),
  );
  if (contractDigest !== manifest.contract.digest) {
    throw new Error(
      `Contract digest mismatch: manifest=${manifest.contract.digest}, computed=${contractDigest}`,
    );
  }

  const outputRoot = resolveInsideRoot(projectRoot, options.out);
  const providerKey = new URL(endpoint).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const providerRoot = resolveInsideRoot(outputRoot, providerKey);
  await mkdir(outputRoot, { recursive: true });
  const stagedProvider = await mkdtemp(join(outputRoot, `.${providerKey}-`));
  for (const document of lexicons) {
    const path = lexiconPath(stagedProvider, document.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  }

  const lock: ProviderLock = {
    format: "contrail.provider-lock",
    version: 1,
    endpoint,
    namespace: manifest.namespace,
    contractDigest: manifest.contract.digest,
    lexiconDigest: manifest.lexicons.digest,
    methods: [...manifest.methods].sort(),
    serviceAuth: manifest.serviceAuth ?? null,
    lexiconRoot: relative(projectRoot, providerRoot),
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

export function registerConnect(cli: CAC): void {
  cli
    .command(
      "connect <endpoint>",
      "Discover a public Contrail, lock its API, pull Lexicons, and generate types",
    )
    .option("--root <path>", "Consumer project root", {
      default: process.cwd(),
    })
    .option("--out <path>", "Provider-owned Lexicon storage relative to root", {
      default: "lexicons/pulled",
    })
    .option("--lock <path>", "Provider lock file relative to root", {
      default: "contrail.lock.json",
    })
    .option("--update", "Replace an existing provider lock and owned Lexicons")
    .option("--no-generate", "Pull and lock without running Atcute lex-cli")
    .action(async (endpoint: string, options: ConnectOptions) => {
      const result = await connectPublicService({
        endpoint,
        root: options.root,
        out: options.out,
        lock: options.lock,
        update: options.update,
      });
      console.log(
        `connected ${result.lock.endpoint}: ${result.written} Lexicons, contract ${result.lock.contractDigest}`,
      );
      if (options.generate !== false) {
        generateLexiconTypesWithAtcute(resolve(options.root));
      }
    });
}
