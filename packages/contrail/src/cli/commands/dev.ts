import { spawn } from "node:child_process";
import type { CAC } from "cac";
import { Contrail } from "../../contrail.js";
import { getBackfillStatus } from "../../core/status.js";
import type { Database } from "../../core/types.js";
import { promptYesNo, resolveAndLoadConfig } from "../shared.js";

interface DevOpts {
  config?: string;
  root: string;
  binding: string;
  cron: string;
  concurrency: number;
  yes?: boolean;
}

export function registerDev(cli: CAC): void {
  cli
    .command(
      "dev",
      "Local wrangler dev + auto-trigger cron + optional backfill prompt"
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)", {
      default: process.cwd(),
    })
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--cron <expr>",
      "Cron expression to fire against /__scheduled (default: every minute)",
      { default: "*/1 * * * *" }
    )
    .option(
      "--concurrency <n>",
      "Concurrency passed to backfill if prompted (default: 100)",
      { default: 100 }
    )
    .option("--yes, -y", "Accept all prompts without asking (CI-friendly)")
    .action(async (options: DevOpts) => {
      const config = await resolveAndLoadConfig(options);

      // Pre-flight: connect to local D1 via wrangler's platform proxy, inspect
      // state, prompt. Then dispose before starting wrangler dev so the two
      // miniflare processes don't fight over the sqlite file.
      const { getPlatformProxy } = await import("wrangler");
      const { env, dispose } = await getPlatformProxy();
      const db = (env as Record<string, unknown>)[options.binding] as
        | Database
        | undefined;

      if (db) {
        const contrail = new Contrail(config);
        await contrail.init(db);

        const backfillStatus = await getBackfillStatus(db, config);

        if (backfillStatus.state !== "complete") {
          if (backfillStatus.state === "not_started") {
            console.log("no backfilled users in the local DB yet.");
          } else {
            console.log(
              `backfill incomplete: ${backfillStatus.accounts.pending} accounts remain; ${backfillStatus.accounts.unreachable} currently unreachable.`
            );
          }
          if (
            await promptYesNo(
              "run or resume backfill now? (takes a few minutes)",
              true,
              !!options.yes
            )
          ) {
            await contrail.backfillAll(
              { concurrency: Number(options.concurrency) },
              db
            );
          }
        }
      }

      await dispose();

      // Start wrangler dev + fire /__scheduled on a loop so the cron actually
      // runs in local dev (wrangler's cron scheduler only works in deployed
      // production; --test-scheduled enables the manual-trigger endpoint).
      const cronUrl = `http://localhost:8787/__scheduled?cron=${encodeURIComponent(options.cron)}`;

      const wrangler = spawn("npx", ["wrangler", "dev", "--test-scheduled"], {
        stdio: "inherit",
        shell: process.platform === "win32",
        cwd: options.root,
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

      const code = await new Promise<number>((resolve) => {
        wrangler.on("exit", (c) => {
          clearTimeout(kickoff);
          clearInterval(interval);
          resolve(c ?? 0);
        });
      });
      process.exit(code);
    });
}
