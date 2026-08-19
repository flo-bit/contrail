/**
 * Helpers shared across `contrail` subcommands.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findConfigFile,
  findLexiconBundle,
  loadConfig,
  loadLexiconBundle,
  CONFIG_CANDIDATES_MESSAGE,
} from "../cli-config.js";
import type { ContrailConfig } from "../core/types.js";

export interface ConfigOpts {
  config?: string;
  root?: string;
}

/**
 * Resolve and load a ContrailConfig from CLI options. Exits with code 1 if no
 * config file is found, since every command except `append-scheduled` needs one.
 */
export async function resolveConfig(
  opts: ConfigOpts,
): Promise<{ config: ContrailConfig; path: string }> {
  const root = opts.root ?? process.cwd();
  const path = findConfigFile(root, opts.config);
  if (!path) {
    throw new Error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        `  ${CONFIG_CANDIDATES_MESSAGE}`,
    );
  }
  return { config: await loadConfig(path), path };
}

export async function resolveAndLoadConfig(
  opts: ConfigOpts,
): Promise<ContrailConfig> {
  return (await resolveConfig(opts)).config;
}

/** Load the standard generated/pinned bundle only when collection policy needs
 * runtime validation. */
export async function resolveValidationLexicons(
  opts: ConfigOpts,
  config: ContrailConfig,
): Promise<object[] | undefined> {
  if (!Object.values(config.collections).some((collection) => collection.validate === true)) {
    return undefined;
  }
  const root = opts.root ?? process.cwd();
  const path = findLexiconBundle(root);
  if (!path) {
    throw new Error(
      "validated collections require a generated Lexicon bundle; run `contrail lexicons all`",
    );
  }
  return loadLexiconBundle(path);
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
