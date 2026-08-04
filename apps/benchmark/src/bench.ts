import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Contrail, type ContrailConfig, type Database } from "@atmo-dev/contrail";
import { getPlatformProxy } from "wrangler";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = resolve(APP_DIR, "configs");
const CACHE_DIR = resolve(APP_DIR, ".cache");
const RESULTS_DIR = resolve(APP_DIR, "results");
const WRANGLER_CONFIG = resolve(APP_DIR, "wrangler.jsonc");

interface Options {
  config: string;
  concurrency: number;
  maxAttempts: number;
  keepCache: boolean;
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
  let maxAttemptsRaw: string | undefined;
  let keepCache = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--config") config = argv[++index];
    else if (arg.startsWith("--config=")) config = arg.slice("--config=".length);
    else if (arg === "--concurrency") concurrencyRaw = argv[++index];
    else if (arg.startsWith("--concurrency=")) {
      concurrencyRaw = arg.slice("--concurrency=".length);
    } else if (arg === "--max-attempts") maxAttemptsRaw = argv[++index];
    else if (arg.startsWith("--max-attempts=")) {
      maxAttemptsRaw = arg.slice("--max-attempts=".length);
    } else if (arg === "--keep-cache") keepCache = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm bench --config <file> [options]

Options:
  --config <file>       JSON config path or filename under configs/ (required)
  --concurrency <n>     Concurrent accounts (default: 100)
  --max-attempts <n>    Initial attempts per failed account (default: 5)
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
    maxAttempts: positiveInteger(maxAttemptsRaw, "--max-attempts", 5),
    keepCache,
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

function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function safeName(path: string): string {
  return basename(path)
    .replace(/\.config\.json$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const configPath = await resolveConfigPath(options.config);
  const config = JSON.parse(await readFile(configPath, "utf8")) as ContrailConfig;
  const name = safeName(configPath);
  const cachePath = resolve(CACHE_DIR, `${name}-c${options.concurrency}`);

  await rm(cachePath, { recursive: true, force: true });
  await mkdir(cachePath, { recursive: true });
  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(`config:       ${configPath}`);
  console.log(`backend:      fresh local D1`);
  console.log(`concurrency:  ${options.concurrency}`);
  console.log(`max attempts: ${options.maxAttempts}`);
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
  let overview: any;

  try {
    let phaseStart = performance.now();
    proxy = await getPlatformProxy({
      configPath: WRANGLER_CONFIG,
      persist: { path: cachePath },
      remoteBindings: false,
      envFiles: [],
    });
    bindingMs = elapsed(phaseStart);

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

    phaseStart = performance.now();
    let lastProgressAt = 0;
    acceptedRecords = await contrail.backfill({
      concurrency: options.concurrency,
      maxAttempts: options.maxAttempts,
      onProgress(progress) {
        const now = Date.now();
        if (now - lastProgressAt < 2_000) return;
        lastProgressAt = now;
        console.log(
          `progress:     ${progress.usersComplete}/${progress.usersTotal} accounts, ` +
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
  } finally {
    await proxy?.dispose();
    if (!options.keepCache) {
      await rm(cachePath, { recursive: true, force: true });
    }
  }

  const totalMs = elapsed(totalStart);
  const completedAt = new Date();
  const indexedRecords = Number(overview.total_records ?? 0);
  const relativeConfig = relative(APP_DIR, configPath);
  const result = {
    format: "contrail.backfill-benchmark",
    version: 1,
    config: relativeConfig.startsWith("..") ? configPath : relativeConfig,
    backend: "wrangler-local-d1",
    options: {
      concurrency: options.concurrency,
      maxAttempts: options.maxAttempts,
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
    backfill: overview.backfill,
    collections: overview.collections,
  };

  const timestamp = completedAt.toISOString().replace(/[:.]/g, "-");
  const resultPath = resolve(
    RESULTS_DIR,
    `${name}-c${options.concurrency}-${timestamp}.json`,
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
