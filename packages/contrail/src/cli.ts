#!/usr/bin/env node
/**
 * contrail — CLI for one-off operations against a contrail deployment.
 *
 * Usage:
 *   contrail backfill [--remote] [--binding DB] [--config path]
 *   contrail refresh  [--remote] [--ignore-window 60s] [--by-collection]
 *   contrail dev      [--binding DB] [--cron '*\/1 * * * *']
 *
 * Config auto-detects at contrail.config.ts, src/contrail.config.ts,
 * src/lib/contrail.config.ts, or app/contrail.config.ts (first match wins).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { findConfigFile, loadConfig, CONFIG_CANDIDATES_MESSAGE } from "./cli-config.js";
import { backfillAll, refresh } from "./workers/backfill.js";
import { Contrail } from "./contrail.js";
import type { CollectionStats, RefreshResult } from "./core/refresh.js";
import type { Database } from "./core/types.js";

type Subcommand = "backfill" | "refresh" | "labels-backfill" | "dev" | "help";

const USAGE = `contrail <subcommand> [options]

Subcommands:
  backfill          One-time bulk load from each known DID's PDS (resumable)
  refresh           Fresh sweep: reconcile PDS vs DB, report missing + stale
  labels-backfill   One-shot drain per configured labeler — runs catch-up cycles
                    until each labeler has no more pending events (resumable)
  dev               Local wrangler dev + auto-trigger cron + backfill/refresh prompts
  help              Print this message

Options (backfill):
  --config <path>      Path to Contrail config file (TS or JS).
  --root <path>        Project root for auto-detection. Default: CWD.
  --remote             Use production D1 bindings.
  --binding <name>     D1 binding name in wrangler.jsonc. Default: "DB".
  --concurrency <n>    Passed to contrail.backfillAll(). Default: 100.

Options (refresh):
  --config <path>      Path to Contrail config file (TS or JS).
  --root <path>        Project root for auto-detection. Default: CWD.
  --remote             Use production D1 bindings.
  --binding <name>     D1 binding name in wrangler.jsonc. Default: "DB".
  --concurrency <n>    Passed to contrail.refresh(). Default: 50.
  --ignore-window <s>  Seconds of grace for stale-update detection. Default: 60.
  --by-collection      Print per-collection stats, not just totals.

Options (dev):
  --config <path>      Path to Contrail config file (TS or JS).
  --root <path>        Project root for auto-detection. Default: CWD.
  --binding <name>     D1 binding name in wrangler.jsonc. Default: "DB".
  --cron <expr>        Cron expression to fire against /__scheduled. Default: "*/1 * * * *".
  --stale-after <min>  Prompt to run refresh if the ingest cursor is older than this. Default: 60.
  --yes                Accept all prompts without asking (CI-friendly).
`;

interface Args {
  cmd: Subcommand;
  config?: string;
  root: string;
  remote: boolean;
  binding: string;
  concurrency?: number;
  ignoreWindowMs?: number;
  byCollection: boolean;
  cron?: string;
  staleAfterMin?: number;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const cmd = (args.shift() ?? "help") as Subcommand;
  let config: string | undefined;
  let root = process.cwd();
  let remote = false;
  let binding = "DB";
  let concurrency: number | undefined;
  let ignoreWindowMs: number | undefined;
  let byCollection = false;
  let cron: string | undefined;
  let staleAfterMin: number | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") config = args[++i];
    else if (a === "--root") root = args[++i];
    else if (a === "--remote") remote = true;
    else if (a === "--binding") binding = args[++i];
    else if (a === "--concurrency") concurrency = parseInt(args[++i], 10);
    else if (a === "--ignore-window") ignoreWindowMs = parseInt(args[++i], 10) * 1000;
    else if (a === "--by-collection") byCollection = true;
    else if (a === "--cron") cron = args[++i];
    else if (a === "--stale-after") staleAfterMin = parseInt(args[++i], 10);
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "-h" || a === "--help")
      return {
        cmd: "help",
        config,
        root,
        remote,
        binding,
        concurrency,
        ignoreWindowMs,
        byCollection,
        cron,
        staleAfterMin,
        yes,
      };
  }
  return { cmd, config, root, remote, binding, concurrency, ignoreWindowMs, byCollection, cron, staleAfterMin, yes };
}

function resolveConfigPath(opts: Args): string | null {
  const p = findConfigFile(opts.root, opts.config);
  if (!p) {
    console.error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        `  ${CONFIG_CANDIDATES_MESSAGE}`
    );
  }
  return p;
}

async function promptYesNo(question: string, defaultYes: boolean, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  // Non-TTY → default-decline; the user isn't there to answer.
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const ans = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (ans === "") return defaultYes;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function formatStats(s: CollectionStats): string {
  return `${s.missing} missing, ${s.staleUpdates} stale updates, ${s.inSync} in sync`;
}

function printRefreshReport(result: RefreshResult, byCollection: boolean): void {
  console.log("");
  if (byCollection) {
    console.log("by collection:");
    const entries = Object.entries(result.byCollection).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [nsid, stats] of entries) {
      if (stats.missing === 0 && stats.staleUpdates === 0 && stats.inSync === 0) continue;
      console.log(`  ${nsid}`);
      console.log(`    ${formatStats(stats)}`);
    }
    console.log("");
  }
  console.log("total:");
  console.log(`  ${formatStats(result.total)}`);
  console.log(`  ${result.usersScanned} users scanned` +
    (result.usersFailed ? `, ${result.usersFailed} failed` : "") +
    ` in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  (ignore window: ${(result.ignoreWindowMs / 1000).toFixed(0)}s)`);
}

async function cmdDev(opts: Args): Promise<number> {
  const configPath = resolveConfigPath(opts);
  if (!configPath) return 1;
  const config = await loadConfig(configPath);

  // Pre-flight: connect to local D1 via wrangler's platform proxy, inspect
  // state, prompt. Then dispose before starting wrangler dev so the two
  // miniflare processes don't fight over the sqlite file.
  const { getPlatformProxy } = await import("wrangler");
  const { env, dispose } = await getPlatformProxy();
  const db = (env as Record<string, unknown>)[opts.binding] as Database | undefined;

  if (db) {
    const contrail = new Contrail(config);
    await contrail.init(db);

    const hasBackfilled = await db
      .prepare("SELECT 1 FROM backfills WHERE completed = 1 LIMIT 1")
      .first();

    if (!hasBackfilled) {
      console.log("no backfilled users in the local DB yet.");
      if (await promptYesNo("run backfill now? (takes a few minutes)", true, opts.yes)) {
        await contrail.backfillAll({ concurrency: opts.concurrency ?? 100 }, db);
      }
    } else {
      const staleAfterMs = (opts.staleAfterMin ?? 60) * 60_000;
      const row = await db
        .prepare("SELECT time_us FROM cursor WHERE id = 1")
        .first<{ time_us: number }>();
      if (row?.time_us) {
        const ageMs = Date.now() - Math.floor(row.time_us / 1000);
        if (ageMs > staleAfterMs) {
          const hrs = (ageMs / 3_600_000).toFixed(1);
          console.log(`ingest cursor is ${hrs}h old — you may have missed events.`);
          if (await promptYesNo("run refresh first?", true, opts.yes)) {
            await contrail.refresh({ ignoreWindowMs: opts.ignoreWindowMs }, db);
          }
        }
      }
    }
  }

  await dispose();

  // Start wrangler dev + fire /__scheduled on a loop so the cron actually
  // runs in local dev (wrangler's cron scheduler only works in deployed
  // production; --test-scheduled enables the manual-trigger endpoint).
  const cron = opts.cron ?? "*/1 * * * *";
  const cronUrl = `http://localhost:8787/__scheduled?cron=${encodeURIComponent(cron)}`;

  const wrangler = spawn("npx", ["wrangler", "dev", "--test-scheduled"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: opts.root,
  });

  // Give wrangler a few seconds to bind the port, then start the cron loop.
  const kickoff = setTimeout(() => {
    fetch(cronUrl).catch(() => {}); // fire-and-forget; first run
    console.log(`\nauto-ingest: firing ${cronUrl} every 60s\n`);
  }, 3_000);

  const interval = setInterval(() => {
    fetch(cronUrl).catch(() => {}); // wrangler may be restarting; swallow
  }, 60_000);

  const cleanup = () => {
    clearTimeout(kickoff);
    clearInterval(interval);
    try {
      wrangler.kill("SIGINT");
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return new Promise<number>((resolve) => {
    wrangler.on("exit", (code) => {
      clearTimeout(kickoff);
      clearInterval(interval);
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);

  if (opts.cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (opts.cmd === "backfill") {
    const configPath = resolveConfigPath(opts);
    if (!configPath) return 1;
    const config = await loadConfig(configPath);
    await backfillAll({
      config,
      remote: opts.remote,
      binding: opts.binding,
      concurrency: opts.concurrency ?? 100,
    });
    return 0;
  }

  if (opts.cmd === "refresh") {
    const configPath = resolveConfigPath(opts);
    if (!configPath) return 1;
    const config = await loadConfig(configPath);
    const result = await refresh({
      config,
      remote: opts.remote,
      binding: opts.binding,
      concurrency: opts.concurrency ?? 50,
      ignoreWindowMs: opts.ignoreWindowMs,
    });
    printRefreshReport(result, opts.byCollection);
    return 0;
  }

  if (opts.cmd === "labels-backfill") {
    const configPath = resolveConfigPath(opts);
    if (!configPath) return 1;
    const config = await loadConfig(configPath);
    if (!config.labels || config.labels.sources.length === 0) {
      console.error("No labels configured (config.labels.sources is empty).");
      return 1;
    }
    const { getPlatformProxy } = await import("wrangler");
    const { env, dispose } = await getPlatformProxy({
      environment: opts.remote ? "production" : undefined,
    });
    try {
      const db = (env as Record<string, unknown>)[opts.binding] as Database | undefined;
      if (!db) {
        console.error(`No binding named "${opts.binding}" in wrangler env.`);
        return 1;
      }
      const contrail = new Contrail(config);
      await contrail.init(db);

      // Run cycles until each cycle drains nothing new — measured by the
      // labeler_cursors not advancing across two consecutive cycles.
      const before = new Map<string, number>();
      let stable = 0;
      while (stable < 2) {
        const rows = (
          await db
            .prepare("SELECT did, cursor FROM labeler_cursors")
            .all<{ did: string; cursor: number }>()
        ).results ?? [];
        for (const r of rows) before.set(r.did, r.cursor);
        await contrail.ingestLabels({ timeoutMs: 60_000 }, db);
        const after = (
          await db
            .prepare("SELECT did, cursor FROM labeler_cursors")
            .all<{ did: string; cursor: number }>()
        ).results ?? [];
        let advanced = false;
        for (const r of after) {
          if ((before.get(r.did) ?? -1) !== r.cursor) {
            advanced = true;
            break;
          }
        }
        stable = advanced ? 0 : stable + 1;
      }
      console.log("labels-backfill: caught up");
      return 0;
    } finally {
      await dispose();
    }
  }

  if (opts.cmd === "dev") return cmdDev(opts);

  console.error(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
