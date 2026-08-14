import type { CAC } from "cac";
import { Contrail } from "../../contrail.js";
import {
  backfillAll,
  bootstrapAlluvium,
  bootstrapAlluviumDatabase,
  labelsBackfillAll,
  labelsBackfillDatabase,
} from "../../workers/backfill.js";
import {
  resolveAndLoadConfig,
  resolveValidationLexicons,
} from "../shared.js";

interface BackfillOpts {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  sqlite?: string;
  concurrency: number;
  pdsConcurrency: number;
  didsPerPds: number;
  maxAttempts: number;
  only?: string;
  alluvium?: boolean;
  alluviumEndpoint: string;
  alluviumSourceId: string;
  alluviumEpoch?: string;
  alluviumRetentionHours: number;
  allowPartial?: boolean;
}

const VALID_ONLY = ["records", "labels"] as const;

export function registerBackfill(cli: CAC): void {
  cli
    .command(
      "backfill",
      "Resumable bulk load from PDS by default, or a fresh Alluvium generation with --alluvium."
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Use production D1 bindings")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--sqlite <path>",
      "Use a local SQLite database instead of a Wrangler D1 binding",
    )
    .option(
      "--concurrency <n>",
      "Concurrent identity resolutions (labels are per-labeler serial)",
      { default: 100 }
    )
    .option(
      "--pds-concurrency <n>",
      "PDS hosts fetched concurrently",
      { default: 20 }
    )
    .option(
      "--dids-per-pds <n>",
      "Accounts fetched concurrently from each PDS",
      { default: 3 }
    )
    .option(
      "--max-attempts <n>",
      "Immediate attempts before deferring failures to scheduled retries",
      { default: 1 }
    )
    .option(
      "--only <kind>",
      "Run only one half: 'records' or 'labels'. Default: both."
    )
    .option(
      "--alluvium",
      "Bootstrap a fresh generation from Alluvium base + archive data",
    )
    .option(
      "--alluvium-endpoint <url>",
      "Alluvium HTTP origin",
      { default: "https://alluvium-v0.atmo.tools" },
    )
    .option(
      "--alluvium-source-id <id>",
      "Logical source ID expected in Alluvium manifests",
      { default: "jetstream-us-east" },
    )
    .option(
      "--alluvium-epoch <epoch>",
      "Operator-owned continuity epoch (required with --alluvium)",
    )
    .option(
      "--alluvium-retention-hours <hours>",
      "Assert direct-source retention for this generation",
      { default: 72 },
    )
    .option(
      "--allow-partial",
      "Accept explicitly reported historical omissions",
    )
    .action(async (options: BackfillOpts) => {
      const only = options.only;
      if (only !== undefined && !VALID_ONLY.includes(only as never)) {
        console.error(
          `--only must be one of: ${VALID_ONLY.join(", ")} (got "${only}")`
        );
        process.exit(1);
      }

      if (options.sqlite && options.remote) {
        console.error("--sqlite cannot be combined with --remote");
        process.exit(1);
      }
      const config = await resolveAndLoadConfig(options);
      const lexicons = await resolveValidationLexicons(options, config);
      const wrangler = {
        config,
        lexicons,
        remote: !!options.remote,
        binding: options.binding,
      };
      const sqliteDb = options.sqlite
        ? (await import("../../adapters/sqlite.js")).createSqliteDatabase(options.sqlite)
        : null;

      if (options.alluvium) {
        if (only !== undefined) {
          console.error("--alluvium cannot be combined with --only");
          process.exit(1);
        }
        if (!options.alluviumEpoch?.trim()) {
          console.error("--alluvium requires --alluvium-epoch <epoch>");
          process.exit(1);
        }
        const retentionHours = Number(options.alluviumRetentionHours);
        if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
          console.error("--alluvium-retention-hours must be a positive number");
          process.exit(1);
        }
        const alluvium = {
          endpoint: options.alluviumEndpoint,
          sourceId: options.alluviumSourceId,
          sourceEpoch: options.alluviumEpoch,
          allowPartial: options.allowPartial === true,
          retentionUs: retentionHours * 60 * 60 * 1_000_000,
        };
        const result = sqliteDb
          ? await bootstrapAlluviumDatabase({
              config,
              db: sqliteDb,
              lexicons,
              ...alluvium,
            })
          : await bootstrapAlluvium({ ...wrangler, ...alluvium });
        console.log(
          `alluvium: ${result.resumed ? "resumed" : "loaded"} base + archive in ` +
            `${(result.elapsedMs / 1000).toFixed(1)}s; ` +
            `live cursor=${result.liveCursor}`,
        );
        console.log(
          "alluvium: offline bootstrap complete; scheduled ingestion owns post-archive catch-up",
        );
        return;
      }

      const runRecords = only !== "labels";
      const runLabels = only !== "records";

      const pdsOptions = {
        concurrency: Number(options.concurrency),
        pdsConcurrency: Number(options.pdsConcurrency),
        didsPerPds: Number(options.didsPerPds),
        maxAttempts: Number(options.maxAttempts),
      };
      let recordsIncomplete = false;
      if (runRecords) {
        const result = sqliteDb
          ? await (async () => {
              const contrail = new Contrail({ ...config, lexicons });
              await contrail.init(sqliteDb);
              return contrail.backfillAll(pdsOptions, sqliteDb);
            })()
          : await backfillAll({ ...wrangler, ...pdsOptions });
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
          const result = sqliteDb
            ? await labelsBackfillDatabase({ config, db: sqliteDb, lexicons })
            : await labelsBackfillAll(wrangler);
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
