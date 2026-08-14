import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CAC } from "cac";
import { Contrail } from "../../contrail.js";
import { createSqliteDatabase } from "../../adapters/sqlite.js";
import { getBackfillStatus } from "../../core/status.js";
import type { ContrailConfig, Database } from "../../core/types.js";
import { generateLexicons } from "../../lexicons/generate.js";
import { createHandler } from "../../server.js";
import { bootstrapAlluviumDatabase } from "../../workers/backfill.js";
import {
  generateLexiconTypesWithAtcute,
  pullLexiconsWithAtcute,
} from "../atcute.js";
import {
  connectPublicService,
  ensureConsumerClientModule,
  ensureConsumerLexiconConfig,
} from "./connect.js";
import {
  promptYesNo,
  resolveAndLoadConfig,
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
  alluviumEpoch?: string;
  alluviumRetentionHours: number;
  allowPartial?: boolean;
  connect?: boolean;
  client?: string;
  clientTypes?: string;
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
    // Localhost notify is deliberately open and loopback-only. A real PDS
    // should not be asked to authorize a fictitious localhost service DID.
    notify,
    orderedSource:
      config.orderedSource ??
      (options.alluvium
        ? {
            source: options.alluviumSourceId,
            epoch: options.alluviumEpoch ?? "contrail-local-alluvium-v1",
          }
        : { source: "jetstream", epoch: "contrail-local-jetstream-v1" }),
  };
}

async function requestBody(request: IncomingMessage): Promise<Buffer | undefined> {
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
      headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
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
    | Database
    | undefined;

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

function defaultDevClientLexiconRoot(projectRoot: string): string {
  return existsSync(join(projectRoot, "src", "lib"))
    ? "src/lib/contrail/lexicons"
    : "src/contrail/lexicons";
}

export function prepareDevLexicons(
  config: ContrailConfig,
  projectRoot: string,
  workspaceRoot: string,
  clientLexiconRoot = resolve(
    projectRoot,
    defaultDevClientLexiconRoot(projectRoot),
  ),
): object[] {
  const pulled = join(workspaceRoot, "dev-pulled");
  const localSourceDirs = [
    join(projectRoot, "lexicons", "custom"),
    join(projectRoot, "lexicons", "pulled"),
    // A prior auto-connect places the complete localhost bundle here. Reuse
    // exact local source documents from that stable path before attempting
    // network resolution, so a developer can add an unpublished Lexicon where
    // the generated consumer already expects it.
    clientLexiconRoot,
  ];
  const sourceDirs = [...localSourceDirs, pulled];
  const output = join(workspaceRoot, "dev-lexicons");
  const pullConfig = join(workspaceRoot, "dev-pull.config.mjs");
  let attempted: string | null = null;

  for (let pass = 0; pass < 5; pass++) {
    const result = generateLexicons({
      config,
      rootDir: workspaceRoot,
      outputDir: output,
      sourceDirs,
      surface: "public",
      writeAtcuteConfig: false,
      quiet: true,
    });
    const available = new Set(
      result.lexicons
        .map((document) => (document as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );
    const missing = result.pullNsids.filter((nsid) => !available.has(nsid));
    if (missing.length === 0) return result.lexicons;

    const current = JSON.stringify(missing);
    if (current === attempted) {
      throw new Error(
        `Could not resolve required development Lexicons: ${missing.join(", ")}`,
      );
    }
    attempted = current;
    // Keep the complete remotely-resolved set in each clean Atcute pull, but
    // do not ask the network for unpublished documents already supplied by the
    // project or its stable generated-consumer root.
    const remoteNsids = result.pullNsids.filter((nsid) => {
      const relativePath = `${nsid.split(".").join("/")}.json`;
      return !localSourceDirs.some((directory) =>
        existsSync(join(directory, relativePath)),
      );
    });
    writeFileSync(
      pullConfig,
      `export default ${JSON.stringify({
        pull: {
          outdir: "dev-pulled",
          clean: true,
          sources: [
            { type: "atproto", mode: "nsids", nsids: remoteNsids },
          ],
        },
      }, null, 2)};\n`,
    );
    console.log(`lexicons: resolving ${missing.join(", ")}`);
    pullLexiconsWithAtcute(workspaceRoot, pullConfig);
  }
  throw new Error("Development Lexicon reference discovery did not converge");
}

function migrateLegacyDevConnection(
  root: string,
  endpoint: string,
  desiredLexiconRoot: string,
): void {
  const lockPath = join(root, "contrail.lock.json");
  if (!existsSync(lockPath)) return;
  let lock: {
    format?: unknown;
    endpoint?: unknown;
    allowInsecureHttp?: unknown;
    lexiconRoot?: unknown;
  };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as typeof lock;
  } catch {
    return;
  }
  if (
    lock.format !== "contrail.provider-lock" ||
    lock.endpoint !== endpoint ||
    lock.allowInsecureHttp !== true ||
    typeof lock.lexiconRoot !== "string" ||
    lock.lexiconRoot === desiredLexiconRoot
  ) {
    return;
  }
  const desired = resolve(root, desiredLexiconRoot);
  const prior = resolve(root, lock.lexiconRoot);
  const child = relative(desired, prior);
  if (!child || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return;
  }
  rmSync(prior, { recursive: true, force: true });
  rmSync(lockPath, { force: true });
}

async function connectDevConsumer(
  options: DevOpts,
  root: string,
  endpoint: string,
  notifyMethod?: string,
): Promise<string | null> {
  if (options.connect === false) return null;
  const svelteRoot = existsSync(join(root, "src", "lib"));
  const lexiconRoot =
    options.clientLexicons ?? defaultDevClientLexiconRoot(root);
  migrateLegacyDevConnection(root, endpoint, lexiconRoot);
  const out = dirname(lexiconRoot);
  const providerKey = basename(lexiconRoot);
  const client =
    options.client ??
    (svelteRoot ? "src/lib/contrail/index.ts" : "src/contrail/index.ts");
  const clientTypes =
    options.clientTypes ??
    (svelteRoot
      ? "src/lib/contrail/types/index.ts"
      : "src/contrail/types/index.ts");
  const lock = "contrail.lock.json";
  const result = await connectPublicService({
    endpoint,
    root,
    out,
    lock,
    update: existsSync(join(root, lock)),
    allowInsecureHttp: true,
    providerKey,
  });
  await ensureConsumerLexiconConfig({
    root,
    out: result.lock.lexiconRoot,
    types: clientTypes,
    lock: result.lock,
  });
  generateLexiconTypesWithAtcute(root);
  const generated = await ensureConsumerClientModule({
    root,
    file: client,
    types: clientTypes,
    lock: result.lock,
    notifyMethod,
  });
  return generated.path;
}

async function runSqliteDev(options: DevOpts, input: ContrailConfig) {
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
    options.clientLexicons ?? defaultDevClientLexiconRoot(root),
  );
  const lexicons = prepareDevLexicons(
    config,
    root,
    lexiconWorkspace,
    clientLexiconRoot,
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
        console.log("backfill: discovering accounts and loading records from PDSes");
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
  let clientPath: string | null;
  try {
    clientPath = await connectDevConsumer(
      options,
      root,
      endpoint,
      contrail.config.notify
        ? `${contrail.config.namespace}.notifyOfUpdate`
        : undefined,
    );
  } catch (error) {
    server.close();
    throw error;
  }

  console.log(`\ncontrail dev ready: ${endpoint}`);
  console.log(`  status:    ${endpoint}/status`);
  console.log(`  discovery: ${endpoint}/.well-known/contrail`);
  console.log(`  sqlite:    ${databasePath}`);
  console.log(
    clientPath
      ? `  client:    ${clientPath}\n`
      : "  client:    disabled (--no-connect)\n",
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
      "--no-connect",
      "Do not generate a localhost consumer lock, Lexicons, types, and client",
    )
    .option("--client <path>", "Generated localhost client module")
    .option("--client-types <path>", "Generated localhost type index")
    .option("--client-lexicons <path>", "Downloaded localhost Lexicon directory")
    .option("--port <n>", "SQLite HTTP service port", { default: 8787 })
    .option("--ingest-interval <seconds>", "Seconds between live ingest cycles", {
      default: 60,
    })
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
    .option("--yes, -y", "Accept Wrangler backfill prompts")
    .option("--alluvium", "Use Alluvium base + archive for SQLite bootstrap")
    .option("--alluvium-endpoint <url>", "Alluvium HTTP origin", {
      default: "https://alluvium-v0.atmo.tools",
    })
    .option("--alluvium-source-id <id>", "Alluvium manifest source ID", {
      default: "jetstream-us-east",
    })
    .option("--alluvium-epoch <epoch>", "Operator-owned continuity epoch")
    .option(
      "--alluvium-retention-hours <hours>",
      "Assert direct-source retention for this generation",
      { default: 72 },
    )
    .option("--allow-partial", "Accept reported Alluvium historical omissions")
    .action(async (options: DevOpts) => {
      const input = await resolveAndLoadConfig(options);
      const wrangler =
        options.wrangler === true ||
        (!options.sqlite && !options.temporary && hasWranglerConfig(options.root));
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
        await runSqliteDev(options, input);
      }
    });
}
