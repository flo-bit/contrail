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
import { resolveAndLoadConfig } from "./cli/shared.js";

const cli = cac("contrail");

registerBackfill(cli);
registerRefresh(cli);
registerDev(cli);
registerAppendScheduled(cli);

// `reap` lives in @atmo-dev/contrail-community after the PR #30 package split.
// Dynamically import so contrail has no compile-time edge into the community
// package (contrail-community already depends on contrail; a static import
// here would create a build cycle). contrail declares contrail-community as an
// optional peer so a consumer that installs both gets `reap` wired up; when
// it's genuinely absent the subcommand is simply omitted.
try {
  const mod = await import("@atmo-dev/contrail-community" as string);
  if (typeof mod.registerReap === "function") {
    mod.registerReap(cli, { resolveAndLoadConfig });
  } else {
    // Loaded, but the expected export is missing — a real packaging problem,
    // not "not installed". Surface it so a broken build is debuggable.
    console.warn(
      "[contrail] @atmo-dev/contrail-community loaded but does not export registerReap; `reap` unavailable."
    );
  }
} catch (err) {
  const code = (err as { code?: string })?.code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    // Expected when contrail-community isn't installed alongside contrail.
    // Debug-level so it doesn't nag, but is visible under DEBUG diagnostics.
    if (process.env.DEBUG) {
      console.debug("[contrail] contrail-community not installed; `reap` unavailable.");
    }
  } else {
    // A different failure (broken export, missing transitive dep, syntax
    // error) — do NOT swallow it, or `reap` silently vanishes with no clue.
    console.warn(
      `[contrail] failed to load @atmo-dev/contrail-community for \`reap\`: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

cli.help();

try {
  cli.parse();
} catch (err) {
  console.error(err);
  process.exit(1);
}
