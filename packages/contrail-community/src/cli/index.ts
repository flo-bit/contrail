#!/usr/bin/env node
/**
 * contrail-community — CLI entrypoint.
 *
 * Exposes `reap` (tombstone stuck provision_attempts in PLC). This lives here,
 * as contrail-community's own bin, rather than only as a dynamically-imported
 * subcommand of `contrail`: the PR #30 package split removed contrail's
 * dependency edge into community code, so under pnpm's isolated node_modules
 * `contrail` cannot resolve `@atmo-dev/contrail-community` and the dynamic
 * import there silently no-ops. Shipping the bin here guarantees `reap` is
 * always reachable wherever contrail-community is installed.
 *
 * Config loading is reconstructed from contrail's public `./cli-config`
 * helpers so contrail-community needs no copy of contrail's CLI plumbing and
 * no new dependency edge (it already depends on `@atmo-dev/contrail`).
 */
import { cac } from "cac";
import {
  findConfigFile,
  loadConfig,
  CONFIG_CANDIDATES_MESSAGE,
} from "@atmo-dev/contrail/cli-config";
import { registerReap } from "./reap.js";

const cli = cac("contrail-community");

registerReap(cli, {
  resolveAndLoadConfig: async (opts) => {
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
  },
});

cli.help();

try {
  cli.parse();
} catch (err) {
  console.error(err);
  process.exit(1);
}
