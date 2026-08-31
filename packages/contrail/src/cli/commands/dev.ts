import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CAC } from "cac";
import { Contrail } from "../../contrail.js";
import { createSqliteDatabase } from "../../adapters/sqlite.js";
import { getBackfillStatus } from "../../core/status.js";
import type { ContrailConfig, Database } from "../../core/types.js";
import { configProjectRoot } from "../../cli-config.js";
import { createHandler } from "../../server.js";
import {
  bootstrapAlluviumDatabase,
  DEFAULT_ALLUVIUM_SOURCE_URL,
} from "../../workers/backfill.js";
import {
  defaultConsumerLexiconRoot,
  prepareDevLexicons,
} from "../dev-lexicons.js";
import {
  confirmUnresolvedLexicons,
  promptYesNo,
  resolveConfig,
  resolveValidationLexicons,
} from "../shared.js";

interface DevOpts {
  config?: string;
  root: string;
  binding: string;
  cron: string;
  concurrency: number;
  yes?: boolean;
  wrangler?: boolean;
  sqlite?: string;
  temporary?: boolean;
  fresh?: boolean;
  backfill?: boolean;
  port: number;
  ingestInterval: number;
  ingestTimeout: number;
  alluvium?: boolean;
  alluviumEndpoint: string;
  alluviumSourceId: string;
  alluviumSourceUrl: string;
  alluviumEpoch?: string;
  alluviumRetentionHours: number;
  allowPartial?: boolean;
  clientLexicons?: string;
}

function hasWranglerConfig(root: string): boolean {
  return ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].some((name) =>
    existsSync(join(root, name)),
  );
}

function positiveNumber(value: number, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${option} must be a positive number`);
  }
  return number;
}

function devConfig(config: ContrailConfig, options: DevOpts): ContrailConfig {
  const notify = config.notify ?? true;
  return {
    ...config,
    // Localhost methods are deliberately open and loopback-only. A real PDS
    // should not be asked to authorize a production service audience for a
    // fictitious localhost deployment.
    notify,
    serviceAuth: undefined,
    orderedSource:
      config.orderedSource ??
      (options.alluvium
        ? {
            source: options.alluviumSourceId,
            epoch: options.alluviumEpoch ?? "contrail-local-alluvium-v1",
          }
        : { source: "jetstream", epoch: "contrail-local-jetstream-v2" }),
  };
}

async function requestBody(
  request: IncomingMessage,
): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function serveFetchResponse(
  request: IncomingMessage,
  response: ServerResponse,
  handle: (request: Request) => Promise<Response>,
  endpoint: string,
): Promise<void> {
  try {
    const headers = new Headers();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.append(
        request.rawHeaders[index]!,
        request.rawHeaders[index + 1]!,
      );
    }
    const body = await requestBody(request);
    const result = await handle(
      new Request(new URL(request.url ?? "/", endpoint), {
        method: request.method,
        headers,
        body,
      }),
    );
    response.statusCode = result.status;
    response.statusMessage = result.statusText;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error("dev server request failed", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
    }
    response.end(JSON.stringify({ error: "Internal server error" }));
  }
}

async function runWranglerDev(
  options: DevOpts,
  config: ContrailConfig,
  lexicons?: object[],
) {
  const { getPlatformProxy } = await import("wrangler");
  const { env, dispose } = await getPlatformProxy();
  const db = (env as Record<string, unknown>)[options.binding] as
    Database | undefined;

  if (db) {
    const contrail = new Contrail({ ...config, lexicons });
    await contrail.init(db);
    const backfillStatus = await getBackfillStatus(db, config);
    if (backfillStatus.state !== "complete" && options.backfill !== false) {
      if (backfillStatus.state === "not_started") {
        console.log("no backfilled users in the local D1 yet.");
      } else {
        console.log(
          `backfill incomplete: ${backfillStatus.accounts.pending} pending, ` +
            `${backfillStatus.accounts.retrying} retrying, ` +
            `${backfillStatus.accounts.failed} failed.`,
        );
      }
      if (
        await promptYesNo(
          "run or resume backfill now? (takes a few minutes)",
          true,
          !!options.yes,
        )
      ) {
        await contrail.backfillAll(
          { concurrency: Number(options.concurrency) },
          db,
        );
      }
    }
  }
  await dispose();

  const cronUrl = `http://localhost:8787/__scheduled?cron=${encodeURIComponent(options.cron)}`;
  const wrangler = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--test-scheduled"],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
      cwd: options.root,
    },
  );
  const kickoff = setTimeout(() => {
    fetch(cronUrl).catch(() => {});
    console.log(`\nauto-ingest: firing ${cronUrl} every 60s\n`);
  }, 3_000);
  const interval = setInterval(() => fetch(cronUrl).catch(() => {}), 60_000);
  const cleanup = () => {
    clearTimeout(kickoff);
    clearInterval(interval);
    try {
      wrangler.kill("SIGINT");
    } catch {
      // Process may already be gone.
    }
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  const code = await new Promise<number>((done) => {
    wrangler.on("exit", (value) => {
      clearTimeout(kickoff);
      clearInterval(interval);
      done(value ?? 0);
    });
  });
  process.exitCode = code;
}

async function runSqliteDev(
  options: DevOpts,
  input: ContrailConfig,
  sourceRoot: string,
) {
  const port = positiveNumber(options.port, "--port");
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new TypeError("--port must be an integer between 1 and 65535");
  }
  const intervalMs =
    positiveNumber(options.ingestInterval, "--ingest-interval") * 1_000;
  const ingestTimeoutMs = positiveNumber(
    options.ingestTimeout,
    "--ingest-timeout",
  );
  const root = resolve(options.root);
  const temporaryRoot = options.temporary
    ? mkdtempSync(join(tmpdir(), "contrail-dev-"))
    : null;
  const removeTemporary = () => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  };
  if (temporaryRoot) process.once("exit", removeTemporary);
  const databasePath = temporaryRoot
    ? join(temporaryRoot, "contrail.sqlite")
    : resolve(root, options.sqlite ?? join(".contrail", "dev.sqlite"));
  if (options.fresh) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }
  mkdirSync(dirname(databasePath), { recursive: true });

  const config = devConfig(input, options);
  const lexiconWorkspace = temporaryRoot ?? join(root, ".contrail");
  mkdirSync(lexiconWorkspace, { recursive: true });
  const clientLexiconRoot = resolve(
    root,
    options.clientLexicons ?? defaultConsumerLexiconRoot(root),
  );
  const lexicons = await prepareDevLexicons(
    config,
    root,
    lexiconWorkspace,
    clientLexiconRoot,
    sourceRoot,
    {
      confirmUnresolved: (nsids) =>
        confirmUnresolvedLexicons(nsids, options.yes === true),
    },
  );
  const db = createSqliteDatabase(databasePath);
  const contrail = new Contrail({ ...config, db, lexicons });
  await contrail.init();

  if (options.backfill !== false) {
    if (options.alluvium) {
      const ordered = contrail.config.orderedSource!;
      if (
        ordered.source !== options.alluviumSourceId ||
        (options.alluviumEpoch && ordered.epoch !== options.alluviumEpoch)
      ) {
        throw new Error(
          "configured orderedSource must match --alluvium-source-id and --alluvium-epoch",
        );
      }
      const retentionHours = positiveNumber(
        options.alluviumRetentionHours,
        "--alluvium-retention-hours",
      );
      const result = await bootstrapAlluviumDatabase({
        config: contrail.config,
        db,
        lexicons,
        endpoint: options.alluviumEndpoint,
        sourceId: ordered.source,
        sourceUrl: options.alluviumSourceUrl,
        sourceEpoch: ordered.epoch,
        retentionUs: retentionHours * 60 * 60 * 1_000_000,
        allowPartial: options.allowPartial === true,
      });
      console.log(
        `alluvium: ${result.resumed ? "resumed" : "loaded"} base + archive in ` +
          `${(result.elapsedMs / 1_000).toFixed(1)}s; ` +
          `live cursor=${result.liveCursor}`,
      );
    } else {
      const status = await getBackfillStatus(db, contrail.config);
      if (status.state !== "complete") {
        console.log(
          "backfill: discovering accounts and loading records from PDSes",
        );
        await contrail.backfillAll(
          { concurrency: Number(options.concurrency) },
          db,
        );
      }
    }
  }

  const endpoint = `http://127.0.0.1:${port}`;
  const handle = createHandler(contrail, {
    lexicons,
    publicService: { endpoint, allowInsecureHttp: true },
  });
  const server = createServer((request, response) => {
    void serveFetchResponse(request, response, handle, endpoint);
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => done());
  });
  console.log(`\ncontrail dev ready: ${endpoint}`);
  console.log(`  status:    ${endpoint}/status`);
  console.log(`  discovery: ${endpoint}/.well-known/contrail`);
  console.log(`  sqlite:    ${databasePath}`);
  console.log(
    "  client:    run `contrail connect <config-path>` to generate\n",
  );

  let ingesting = false;
  const ingest = async () => {
    if (ingesting) return;
    ingesting = true;
    try {
      await contrail.ingest({ timeoutMs: ingestTimeoutMs });
      await contrail.retryBackfill(
        { timeoutMs: Math.min(5_000, ingestTimeoutMs) },
        db,
      );
    } catch (error) {
      console.error("scheduled dev ingestion failed", error);
    } finally {
      ingesting = false;
    }
  };
  void ingest();
  const interval = setInterval(() => void ingest(), intervalMs);

  await new Promise<void>((done) => {
    const close = () => {
      clearInterval(interval);
      server.close(() => done());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  if (temporaryRoot) {
    process.removeListener("exit", removeTemporary);
    removeTemporary();
  }
}

export function registerDev(cli: CAC): void {
  cli
    .command(
      "dev",
      "Run a local Contrail service with automatic backfill and ingestion",
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)", {
      default: process.cwd(),
    })
    .option("--wrangler", "Force the existing Wrangler/D1 development mode")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--sqlite <path>",
      "Use SQLite at this path (default without Wrangler: .contrail/dev.sqlite)",
    )
    .option("--temporary", "Use and delete an OS-temporary SQLite database")
    .option("--fresh", "Delete the selected SQLite database before starting")
    .option("--no-backfill", "Start without running or resuming backfill")
    .option(
      "--client-lexicons <path>",
      "Additional stable local Lexicon directory used during resolution",
    )
    .option("--port <n>", "SQLite HTTP service port", { default: 8787 })
    .option(
      "--ingest-interval <seconds>",
      "Seconds between live ingest cycles",
      {
        default: 60,
      },
    )
    .option("--ingest-timeout <ms>", "Budget for each live ingest cycle", {
      default: 15_000,
    })
    .option(
      "--cron <expr>",
      "Cron expression fired in Wrangler mode (default: every minute)",
      { default: "*/1 * * * *" },
    )
    .option("--concurrency <n>", "PDS backfill identity concurrency", {
      default: 100,
    })
    .option("--yes, -y", "Accept confirmation prompts")
    .option("--alluvium", "Use Alluvium base + archive for SQLite bootstrap")
    .option("--alluvium-endpoint <url>", "Alluvium HTTP origin", {
      default: "https://alluvium-v0.atmo.tools",
    })
    .option("--alluvium-source-id <id>", "Alluvium manifest source ID", {
      default: "jetstream-us-east",
    })
    .option(
      "--alluvium-source-url <url>",
      "Exact legacy Jetstream v1 URL advertised by Alluvium manifests",
      { default: DEFAULT_ALLUVIUM_SOURCE_URL },
    )
    .option("--alluvium-epoch <epoch>", "Operator-owned continuity epoch")
    .option(
      "--alluvium-retention-hours <hours>",
      "Assert direct-source retention for this generation",
      { default: 72 },
    )
    .option("--allow-partial", "Accept reported Alluvium historical omissions")
    .action(async (options: DevOpts) => {
      const resolved = await resolveConfig(options);
      const input = resolved.config;
      const wrangler =
        options.wrangler === true ||
        (!options.sqlite &&
          !options.temporary &&
          hasWranglerConfig(options.root));
      if (wrangler) {
        if (options.alluvium) {
          throw new Error(
            "--alluvium dev currently uses SQLite; pass --sqlite or run the D1 backfill command first",
          );
        }
        await runWranglerDev(
          options,
          input,
          await resolveValidationLexicons(options, input),
        );
      } else {
        await runSqliteDev(options, input, configProjectRoot(resolved.path));
      }
    });
}
