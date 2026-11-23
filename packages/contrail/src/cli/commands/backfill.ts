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
  DEFAULT_ALLUVIUM_ENDPOINT,
  type AlluviumProgress,
} from "../../adapters/alluvium.js";
import {
  resolveAndLoadConfig,
  resolveValidationLexicons,
} from "../shared.js";

interface BackfillOpts {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  env?: string;
  wranglerConfig?: string;
  sqlite?: string;
  concurrency: number;
  pdsConcurrency: number;
  didsPerPds: number;
  maxAttempts: number;
  only?: string;
  alluvium?: boolean;
  alluviumEndpoint: string;
  alluviumToken?: string;
}

const VALID_ONLY = ["records", "labels"] as const;

export function registerBackfill(cli: CAC): void {
  cli
    .command(
      "backfill",
      "Resumable bulk load from PDS by default, or a fresh generation from an Alluvium export with --alluvium."
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Connect to the remote Cloudflare D1 database for --binding")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option("--env <name>", "Wrangler environment name in wrangler.jsonc (optional)")
    .option(
      "--wrangler-config <path>",
      "Path to wrangler.jsonc / wrangler.json / wrangler.toml",
    )
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
      "Bootstrap a fresh generation from an Alluvium export instead of PDSes",
    )
    .option(
      "--alluvium-endpoint <url>",
      "Alluvium HTTP origin",
      { default: DEFAULT_ALLUVIUM_ENDPOINT },
    )
    .option(
      "--alluvium-token <token>",
      "Bearer token, when the Alluvium service requires one (or set ALLUVIUM_TOKEN)",
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
        env: options.env,
        wranglerConfig: options.wranglerConfig,
        root: options.root,
      };
      const sqliteDb = options.sqlite
        ? (await import("../../adapters/sqlite.js")).createSqliteDatabase(options.sqlite)
        : null;

      if (options.alluvium) {
        // An export holds records only, so `--only records` changes nothing.
        if (only === "labels") {
          console.error("--alluvium loads records; it cannot be combined with --only labels");
          process.exit(1);
        }
        let lastLogAt = 0;
        let lastStageKey = "";
        const onProgress = (progress: AlluviumProgress): void => {
          const stageKey = `${progress.phase}:${progress.stage ?? ""}:${progress.collection ?? ""}:${progress.relation ?? ""}`;
          const nowMs = performance.now();
          if (stageKey === lastStageKey && nowMs - lastLogAt < 5_000) return;
          lastStageKey = stageKey;
          lastLogAt = nowMs;
          const secs = (progress.elapsedMs / 1000).toFixed(1);
          if (progress.phase === "loading") {
            const rate =
              progress.elapsedMs > 0
                ? Math.round((progress.records * 1000) / progress.elapsedMs)
                : 0;
            console.log(
              `alluvium: loading ${progress.records.toLocaleString("en-US")} records (${secs}s, ${rate.toLocaleString("en-US")} rec/s)`,
            );
          } else {
            const target = progress.relation
              ? `${progress.collection}.${progress.relation}`
              : progress.collection;
            console.log(
              `alluvium: rebuilding ${progress.stage} (${target}): ${progress.records.toLocaleString("en-US")} rows (${secs}s)`,
            );
          }
        };
        const alluvium = {
          endpoint: options.alluviumEndpoint,
          token: options.alluviumToken ?? process.env.ALLUVIUM_TOKEN,
          onProgress,
        };
        const result = sqliteDb
          ? await bootstrapAlluviumDatabase({
              config,
              db: sqliteDb,
              lexicons,
              ...alluvium,
              // A local file can index the loaded data in one pass.
              deferIndexes: true,
            })
          : await bootstrapAlluvium({ ...wrangler, ...alluvium });
        console.log(
          result.alreadyComplete
            ? "alluvium: this database is already loaded; nothing to do"
            : `alluvium: ${result.resumed ? "resumed" : "loaded"} export in ` +
                `${(result.elapsedMs / 1000).toFixed(1)}s; ` +
                `live cursor=${result.liveCursor}\n` +
                "alluvium: bootstrap complete; scheduled ingestion resumes from just before the export",
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
