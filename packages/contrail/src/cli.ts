#!/usr/bin/env node
/**
 * contrail — CLI entrypoint.
 *
 * Subcommand implementations live in `./cli/commands/`; this file just wires
 * them into a single cac instance. See `contrail --help` for usage.
 */
import { cac } from "cac";
import { registerBackfill } from "./cli/commands/backfill.js";
import { registerRefresh } from "./cli/commands/refresh.js";
import { registerDev } from "./cli/commands/dev.js";
import { registerAppendScheduled } from "./cli/commands/append-scheduled.js";
import { registerReap } from "./cli/commands/reap.js";

const cli = cac("contrail");

registerBackfill(cli);
registerRefresh(cli);
registerDev(cli);
registerAppendScheduled(cli);
registerReap(cli);

cli.help();

try {
  cli.parse();
} catch (err) {
  console.error(err);
  process.exit(1);
}
