/**
 * Helpers shared across `contrail` subcommands.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findConfigFile,
  loadConfig,
  CONFIG_CANDIDATES_MESSAGE,
} from "../cli-config.js";
import type { ContrailConfig } from "../core/types.js";
import type {
  CollectionStats,
  RefreshResult,
} from "../core/refresh.js";

export interface ConfigOpts {
  config?: string;
  root?: string;
}

/**
 * Resolve and load a ContrailConfig from CLI options. Exits with code 1 if no
 * config file is found, since every command except `append-scheduled` needs one.
 */
export async function resolveAndLoadConfig(
  opts: ConfigOpts
): Promise<ContrailConfig> {
  const root = opts.root ?? process.cwd();
  const path = findConfigFile(root, opts.config);
  if (!path) {
    console.error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        `  ${CONFIG_CANDIDATES_MESSAGE}`
    );
    process.exit(1);
  }
  return loadConfig(path);
}

/**
 * Yes/no prompt that respects --yes (auto-accept) and falls back to the
 * provided default in non-TTY environments — the user isn't there to answer.
 */
export async function promptYesNo(
  question: string,
  defaultYes: boolean,
  autoYes: boolean
): Promise<boolean> {
  if (autoYes) return true;
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

export function formatStats(s: CollectionStats): string {
  return `${s.missing} missing, ${s.staleUpdates} stale updates, ${s.inSync} in sync`;
}

export function printRefreshReport(
  result: RefreshResult,
  byCollection: boolean
): void {
  console.log("");
  if (byCollection) {
    console.log("by collection:");
    const entries = Object.entries(result.byCollection).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [nsid, stats] of entries) {
      if (stats.missing === 0 && stats.staleUpdates === 0 && stats.inSync === 0)
        continue;
      console.log(`  ${nsid}`);
      console.log(`    ${formatStats(stats)}`);
    }
    console.log("");
  }
  console.log("total:");
  console.log(`  ${formatStats(result.total)}`);
  console.log(
    `  ${result.usersScanned} users scanned` +
      (result.usersFailed ? `, ${result.usersFailed} failed` : "") +
      ` in ${(result.elapsedMs / 1000).toFixed(1)}s`
  );
  console.log(`  (ignore window: ${(result.ignoreWindowMs / 1000).toFixed(0)}s)`);
}
