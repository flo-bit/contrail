import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import {
  Contrail,
  type ContrailConfig,
  type Database,
  type LexiconDoc,
} from "@atmo-dev/contrail";
import { getPlatformProxy } from "wrangler";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = resolve(APP_DIR, "configs");
const CACHE_DIR = resolve(APP_DIR, ".cache");
const RESULTS_DIR = resolve(APP_DIR, "results");
const WRANGLER_CONFIG = resolve(APP_DIR, "wrangler.jsonc");
const require = createRequire(import.meta.url);

interface Options {
  config: string;
  concurrency: number;
  pdsConcurrency: number;
  didsPerPds: number;
  maxAttempts: number;
  keepCache: boolean;
  excludeDids: string[];
  validationLexicons?: string;
}

function positiveInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got ${raw})`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  let config: string | undefined;
  let concurrencyRaw: string | undefined;
  let pdsConcurrencyRaw: string | undefined;
  let didsPerPdsRaw: string | undefined;
  let maxAttemptsRaw: string | undefined;
  let keepCache = false;
  let validationLexicons: string | undefined;
  const excludeDids: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--config") config = argv[++index];
    else if (arg.startsWith("--config=")) config = arg.slice("--config=".length);
    else if (arg === "--concurrency") concurrencyRaw = argv[++index];
    else if (arg.startsWith("--concurrency=")) {
      concurrencyRaw = arg.slice("--concurrency=".length);
    } else if (arg === "--pds-concurrency") pdsConcurrencyRaw = argv[++index];
    else if (arg.startsWith("--pds-concurrency=")) {
      pdsConcurrencyRaw = arg.slice("--pds-concurrency=".length);
    } else if (arg === "--dids-per-pds") didsPerPdsRaw = argv[++index];
    else if (arg.startsWith("--dids-per-pds=")) {
      didsPerPdsRaw = arg.slice("--dids-per-pds=".length);
    } else if (arg === "--max-attempts") maxAttemptsRaw = argv[++index];
    else if (arg.startsWith("--max-attempts=")) {
      maxAttemptsRaw = arg.slice("--max-attempts=".length);
    } else if (arg === "--exclude-did") excludeDids.push(argv[++index]);
    else if (arg.startsWith("--exclude-did=")) {
      excludeDids.push(arg.slice("--exclude-did=".length));
    } else if (arg === "--validation-lexicons") {
      validationLexicons = argv[++index];
    } else if (arg.startsWith("--validation-lexicons=")) {
      validationLexicons = arg.slice("--validation-lexicons=".length);
    } else if (arg === "--keep-cache") keepCache = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm bench --config <file> [options]

Options:
  --config <file>       JSON config path or filename under configs/ (required)
  --concurrency <n>     Concurrent identity resolutions (default: 100)
  --pds-concurrency <n> Concurrent PDS hosts (default: 20)
  --dids-per-pds <n>    Concurrent accounts per PDS (default: 3)
  --max-attempts <n>    Immediate attempts per failed account (default: 1)
  --exclude-did <did>   Skip an actor after discovery (repeatable)
  --validation-lexicons <dir>
                        Enable strict Lexicon + CID validation with JSON docs
  --keep-cache          Keep the disposable local D1 after the run
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config) throw new Error("--config is required");
  return {
    config,
    concurrency: positiveInteger(concurrencyRaw, "--concurrency", 100),
    pdsConcurrency: positiveInteger(pdsConcurrencyRaw, "--pds-concurrency", 20),
    didsPerPds: positiveInteger(didsPerPdsRaw, "--dids-per-pds", 3),
    maxAttempts: positiveInteger(maxAttemptsRaw, "--max-attempts", 1),
    keepCache,
    excludeDids,
    validationLexicons,
  };
}

async function resolveConfigPath(input: string): Promise<string> {
  const candidates = isAbsolute(input)
    ? [input]
    : [resolve(process.cwd(), input), resolve(CONFIG_DIR, input)];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`Config not found: ${input}`);
}

async function loadLexiconDirectory(input: string): Promise<{
  path: string;
  documents: object[];
}> {
  const path = isAbsolute(input) ? input : resolve(process.cwd(), input);
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
  if (files.length === 0) throw new Error(`No Lexicon JSON files found: ${path}`);
  const documents = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as object),
  );
  return { path, documents };
}

async function installedPackageVersion(
  name: string,
  packageRequire: NodeJS.Require = require,
): Promise<string | null> {
  try {
    const packagePath = packageRequire.resolve(`${name}/package.json`);
    const metadata = JSON.parse(await readFile(packagePath, "utf8")) as {
      version?: unknown;
    };
    return typeof metadata.version === "string" ? metadata.version : null;
  } catch {
    return null;
  }
}

function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function safeName(path: string): string {
  return basename(path)
    .replace(/\.config\.json$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-");
}

interface FetchMetric {
  requests: number;
  errors: number;
  total_ms: number;
  max_ms: number;
  statuses: Record<string, number>;
}

function instrumentFetch(): {
  metrics: Map<string, FetchMetric>;
  restore(): void;
  maxActive(): number;
} {
  const original = globalThis.fetch;
  const metrics = new Map<string, FetchMetric>();
  let active = 0;
  let peakActive = 0;

  globalThis.fetch = async (input, init) => {
    let key = "invalid-url";
    try {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw);
      const operation = url.pathname.split("/").pop() || url.pathname;
      key = `${url.host}/${operation}`;
    } catch {
      // Keep the fallback key.
    }

    const metric = metrics.get(key) ?? {
      requests: 0,
      errors: 0,
      total_ms: 0,
      max_ms: 0,
      statuses: {},
    };
    metrics.set(key, metric);
    metric.requests++;
    active++;
    peakActive = Math.max(peakActive, active);
    const start = performance.now();
    try {
      const response = await original(input, init);
      const status = String(response.status);
      metric.statuses[status] = (metric.statuses[status] ?? 0) + 1;
      return response;
    } catch (error) {
      metric.errors++;
      throw error;
    } finally {
      const duration = performance.now() - start;
      metric.total_ms += duration;
      metric.max_ms = Math.max(metric.max_ms, duration);
      active--;
    }
  };

  return {
    metrics,
    restore() {
      globalThis.fetch = original;
    },
    maxActive() {
      return peakActive;
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const configPath = await resolveConfigPath(options.config);
  const config = JSON.parse(await readFile(configPath, "utf8")) as ContrailConfig;
  const validation = options.validationLexicons
    ? await loadLexiconDirectory(options.validationLexicons)
    : null;
  if (validation) {
    config.validation = {
      lexicons: validation.documents as LexiconDoc[],
      strict: true,
      verifyCid: true,
    };
  }
  const wranglerPackagePath = require.resolve("wrangler/package.json");
  const runtime = {
    node: process.version,
    wrangler: await installedPackageVersion("wrangler"),
    workerd: await installedPackageVersion(
      "workerd",
      createRequire(wranglerPackagePath),
    ),
  };
  const name = `${safeName(configPath)}${validation ? "-validated" : ""}`;
  const cachePath = resolve(
    CACHE_DIR,
    `${name}-r${options.concurrency}-h${options.pdsConcurrency}-d${options.didsPerPds}`,
  );

  await rm(cachePath, { recursive: true, force: true });
  await mkdir(cachePath, { recursive: true });
  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(`config:       ${configPath}`);
  console.log(`backend:      fresh local D1`);
  console.log(
    `runtime:      Wrangler ${runtime.wrangler ?? "unknown"}, ` +
      `workerd ${runtime.workerd ?? "unknown"}`,
  );
  console.log(`resolution:   ${options.concurrency}`);
  console.log(`PDS hosts:   ${options.pdsConcurrency}`);
  console.log(`DIDs / PDS:  ${options.didsPerPds}`);
  console.log(`max attempts: ${options.maxAttempts}`);
  console.log(`excluded:     ${options.excludeDids.length} actors`);
  console.log(`validation:   ${validation ? `${validation.documents.length} Lexicons + CID` : "disabled"}`);
  console.log(`cache:        reset ${cachePath}`);

  const startedAt = new Date();
  const totalStart = performance.now();
  let proxy: Awaited<ReturnType<typeof getPlatformProxy>> | undefined;
  let bindingMs = 0;
  let initMs = 0;
  let discoveryMs = 0;
  let backfillMs = 0;
  let discovered = 0;
  let acceptedRecords = 0;
  let backfillMetrics: any;
  let overview: any;
  let diagnostics: any;
  let fetchInstrumentation: ReturnType<typeof instrumentFetch> | undefined;

  try {
    let phaseStart = performance.now();
    proxy = await getPlatformProxy({
      configPath: WRANGLER_CONFIG,
      persist: { path: cachePath },
      remoteBindings: false,
      envFiles: [],
    });
    bindingMs = elapsed(phaseStart);
    fetchInstrumentation = instrumentFetch();

    const db = (proxy.env as Record<string, unknown>).DB as Database;
    const contrail = new Contrail({ ...config, db });

    phaseStart = performance.now();
    await contrail.init();
    initMs = elapsed(phaseStart);

    phaseStart = performance.now();
    const dids = await contrail.discover();
    discovered = dids.length;
    discoveryMs = elapsed(phaseStart);
    console.log(`discovered:   ${discovered} accounts in ${(discoveryMs / 1000).toFixed(2)}s`);

    for (const did of new Set(options.excludeDids)) {
      await db.prepare("DELETE FROM backfills WHERE did = ?").bind(did).run();
    }

    phaseStart = performance.now();
    const backfillStart = phaseStart;
    let lastProgressAt = 0;
    acceptedRecords = await contrail.backfill({
      concurrency: options.concurrency,
      pdsConcurrency: options.pdsConcurrency,
      didsPerPds: options.didsPerPds,
      maxAttempts: options.maxAttempts,
      onMetrics(metrics) {
        backfillMetrics = metrics;
      },
      onProgress(progress) {
        const now = Date.now();
        if (now - lastProgressAt < 2_000) return;
        lastProgressAt = now;
        const seconds = ((performance.now() - backfillStart) / 1000).toFixed(1);
        console.log(
          `progress:     +${seconds}s ${progress.usersComplete}/${progress.usersTotal} accounts, ` +
            `${progress.records} accepted, ${progress.usersFailed} failed`,
        );
      },
    });
    backfillMs = elapsed(phaseStart);

    const response = await contrail
      .app()
      .fetch(new Request("http://benchmark/status"));
    if (!response.ok) throw new Error(`Status request failed: ${response.status}`);
    overview = await response.json();
    diagnostics = await contrail.diagnostics();
  } finally {
    fetchInstrumentation?.restore();
    await proxy?.dispose();
    if (!options.keepCache) {
      await rm(cachePath, { recursive: true, force: true });
    }
  }

  const totalMs = elapsed(totalStart);
  const completedAt = new Date();
  const indexedRecords = Number(overview.total_records ?? 0);
  const relativeConfig = relative(APP_DIR, configPath);
  const network = Object.fromEntries(
    [...(fetchInstrumentation?.metrics ?? new Map())].map(([key, metric]) => [
      key,
      {
        ...metric,
        total_ms: Math.round(metric.total_ms * 100) / 100,
        max_ms: Math.round(metric.max_ms * 100) / 100,
      },
    ]),
  );
  const result = {
    format: "contrail.backfill-benchmark",
    version: 1,
    config: relativeConfig.startsWith("..") ? configPath : relativeConfig,
    backend: "wrangler-local-d1",
    runtime,
    options: {
      concurrency: options.concurrency,
      pdsConcurrency: options.pdsConcurrency,
      didsPerPds: options.didsPerPds,
      maxAttempts: options.maxAttempts,
      excludedDids: options.excludeDids,
      validation: validation
        ? {
            lexicons: relative(APP_DIR, validation.path),
            documents: validation.documents.length,
            strict: true,
            verifyCid: true,
          }
        : null,
    },
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    timings_ms: {
      binding: bindingMs,
      init: initMs,
      discovery: discoveryMs,
      backfill: backfillMs,
      total: totalMs,
    },
    throughput: {
      accepted_records_per_second:
        backfillMs > 0 ? Math.round((acceptedRecords / (backfillMs / 1000)) * 100) / 100 : 0,
      indexed_records_per_second:
        totalMs > 0 ? Math.round((indexedRecords / (totalMs / 1000)) * 100) / 100 : 0,
    },
    discovered_accounts: discovered,
    accepted_records: acceptedRecords,
    indexed_records: indexedRecords,
    peak_rss_kib: process.resourceUsage().maxRSS,
    phases: backfillMetrics,
    network: {
      max_concurrent: fetchInstrumentation?.maxActive() ?? 0,
      requests: network,
    },
    backfill: overview.backfill,
    collections: overview.collections,
    ingest_diagnostics: diagnostics,
  };

  const timestamp = completedAt.toISOString().replace(/[:.]/g, "-");
  const resultPath = resolve(
    RESULTS_DIR,
    `${name}-r${options.concurrency}-h${options.pdsConcurrency}-d${options.didsPerPds}-${timestamp}.json`,
  );
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log("");
  console.log(`backfill:     ${(backfillMs / 1000).toFixed(2)}s`);
  console.log(`total:        ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`indexed:      ${indexedRecords} records`);
  console.log(
    `throughput:   ${result.throughput.accepted_records_per_second.toFixed(2)} accepted records/s`,
  );
  console.log(
    `accounts:     ${overview.backfill.accounts.complete} complete, ` +
      `${overview.backfill.accounts.pending} pending, ` +
      `${overview.backfill.accounts.retrying} retrying, ` +
      `${overview.backfill.accounts.failed} failed`,
  );
  console.log(`network max:  ${result.network.max_concurrent} concurrent requests`);
  const rejected = (diagnostics ?? []).reduce(
    (total: number, diagnostic: { total?: number }) =>
      total + Number(diagnostic.total ?? 0),
    0,
  );
  console.log(`rejections:   ${rejected} aggregate admission decisions`);
  if (backfillMetrics) {
    console.log(
      `phases:       resolution ${(backfillMetrics.resolution_ms / 1000).toFixed(2)}s, ` +
        `derived ${(backfillMetrics.derived_rebuild_ms / 1000).toFixed(2)}s`,
    );
    for (const [collection, metric] of Object.entries(
      backfillMetrics.collections,
    ) as Array<[string, any]>) {
      console.log(
        `collection:   ${collection} — ${metric.fetched_records} fetched, ` +
          `${metric.accepted_records} accepted, ${metric.requests} requests, ` +
          `${(metric.fetch_ms / 1000).toFixed(2)}s fetch, ` +
          `${(metric.projection_and_checkpoint_ms / 1000).toFixed(2)}s project/checkpoint`,
      );
    }
  }
  for (const [key, metric] of Object.entries(network)) {
    console.log(
      `network:      ${key} — ${metric.requests} requests, ` +
        `${(metric.total_ms / 1000).toFixed(2)}s cumulative, ` +
        `${(metric.max_ms / 1000).toFixed(2)}s max`,
    );
  }
  console.log(`result:       ${resultPath}`);

  if (overview.backfill.state !== "complete") {
    console.error(`Benchmark ended with backfill state: ${overview.backfill.state}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
