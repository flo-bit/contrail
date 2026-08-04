import type { CAC } from "cac";
import { backfillAll, labelsBackfillAll } from "../../workers/backfill.js";
import { resolveAndLoadConfig } from "../shared.js";

interface BackfillOpts {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  concurrency: number;
  maxAttempts: number;
  only?: string;
}

const VALID_ONLY = ["records", "labels"] as const;

export function registerBackfill(cli: CAC): void {
  cli
    .command(
      "backfill",
      "One-time bulk load: records from each known DID's PDS, then labels from each configured labeler. Resumable."
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Use production D1 bindings")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--concurrency <n>",
      "Concurrency for record backfill (labels are per-labeler serial)",
      { default: 100 }
    )
    .option(
      "--max-attempts <n>",
      "Failed attempts before leaving an account pending for the next run",
      { default: 5 }
    )
    .option(
      "--only <kind>",
      "Run only one half: 'records' or 'labels'. Default: both."
    )
    .action(async (options: BackfillOpts) => {
      const only = options.only;
      if (only !== undefined && !VALID_ONLY.includes(only as never)) {
        console.error(
          `--only must be one of: ${VALID_ONLY.join(", ")} (got "${only}")`
        );
        process.exit(1);
      }

      const config = await resolveAndLoadConfig(options);
      const wrangler = {
        config,
        remote: !!options.remote,
        binding: options.binding,
      };

      const runRecords = only !== "labels";
      const runLabels = only !== "records";

      let recordsIncomplete = false;
      if (runRecords) {
        const result = await backfillAll({
          ...wrangler,
          concurrency: Number(options.concurrency),
          maxAttempts: Number(options.maxAttempts),
        });
        recordsIncomplete = result.status.state !== "complete";
      }

      if (runLabels) {
        const labelsConfigured =
          !!config.labels && config.labels.sources.length > 0;
        if (!labelsConfigured) {
          if (only === "labels") {
            console.error(
              "No labels configured (config.labels.sources is empty)."
            );
            process.exit(1);
          }
          // --only not set and labels aren't configured: skip silently.
        } else {
          const result = await labelsBackfillAll(wrangler);
          console.log(
            `labels: caught up after ${result.cycles} cycle${result.cycles === 1 ? "" : "s"}`
          );
        }
      }

      if (recordsIncomplete) {
        console.error(
          "Record backfill remains incomplete. Failed rows were kept pending; rerun this command to retry them."
        );
        process.exitCode = 1;
      }
    });
}
