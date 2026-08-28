#!/usr/bin/env node
/**
 * contrail — CLI entrypoint.
 *
 * Subcommand implementations live in `./cli/commands/`; this file just wires
 * them into a single cac instance. See `contrail --help` for usage.
 */
import { cac } from "cac";
import { registerBackfill } from "./cli/commands/backfill.js";
import { registerDev } from "./cli/commands/dev.js";
import { registerAppendScheduled } from "./cli/commands/append-scheduled.js";
import { registerConnect } from "./cli/commands/connect.js";
import { registerLexicons } from "./cli/commands/lexicons.js";
import { registerChanges } from "./cli/commands/changes.js";

const cli = cac("contrail");

registerBackfill(cli);
registerDev(cli);
registerAppendScheduled(cli);
registerConnect(cli);
registerLexicons(cli);
registerChanges(cli);

cli.help();

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (err) {
  console.error(err);
  process.exit(1);
}
