import type { CAC } from "cac";
import { Contrail } from "../../contrail.js";
import type { Database } from "../../core/types.js";
import {
  resolveAndLoadConfig,
  resolveValidationLexicons,
} from "../shared.js";

interface ChangeCommandOptions {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  sqlite?: string;
  json?: boolean;
  through?: string;
  reason?: string;
  yes?: boolean;
  maxBatches?: number;
  olderThan?: number;
}

async function withChangesDatabase<T>(
  options: ChangeCommandOptions,
  callback: (contrail: Contrail, db: Database) => Promise<T>,
): Promise<T> {
  if (options.sqlite && options.remote) {
    throw new Error("--sqlite cannot be combined with --remote");
  }
  const config = await resolveAndLoadConfig(options);
  const lexicons = await resolveValidationLexicons(options, config);
  const contrail = new Contrail({ ...config, lexicons });
  if (options.sqlite) {
    const { createSqliteDatabase } = await import("../../adapters/sqlite.js");
    const db = createSqliteDatabase(options.sqlite);
    await contrail.init(db);
    return callback(contrail, db);
  }

  const { getPlatformProxy } = await import("wrangler");
  const { env, dispose } = await getPlatformProxy({
    environment: options.remote ? "production" : undefined,
  });
  const binding = options.binding ?? "DB";
  const db = (env as Record<string, unknown>)[binding] as Database | undefined;
  if (!db) {
    await dispose();
    throw new Error(`No binding named "${binding}" in wrangler env`);
  }
  try {
    await contrail.init(db);
    return await callback(contrail, db);
  } finally {
    await dispose();
  }
}

function options(command: ReturnType<CAC["command"]>) {
  return command
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Use production D1 bindings")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--sqlite <path>",
      "Use a local SQLite database instead of a Wrangler D1 binding",
    );
}

export function registerChanges(cli: CAC): void {
  options(
    cli.command(
      "changes <action> [consumer]",
      "Private change-log operations: status, retry, prune, skip",
    ),
  )
    .option("--json", "Print machine-readable status JSON")
    .option("--through <position>", "Required position for changes skip")
    .option("--reason <text>", "Required operator reason for changes skip")
    .option("--yes", "Confirm the data loss caused by changes skip")
    .option("--max-batches <n>", "Maximum rows for one prune slice", {
      default: 500,
    })
    .option("--older-than <timestamp>", "Prune only rows older than milliseconds")
    .action(
      async (
        action: string,
        consumer: string | undefined,
        commandOptions: ChangeCommandOptions,
      ) => {
        const actions = ["status", "retry", "prune", "skip"];
        if (!actions.includes(action)) {
          throw new Error(`changes action must be one of: ${actions.join(", ")}`);
        }
        if ((action === "retry" || action === "skip") && !consumer) {
          throw new Error(`changes ${action} requires a consumer ID`);
        }
        if ((action === "status" || action === "prune") && consumer) {
          throw new Error(`changes ${action} does not accept a consumer ID`);
        }

        await withChangesDatabase(commandOptions, async (contrail, db) => {
          if (action === "retry") {
            await contrail.changes.retry(consumer!, undefined, db);
            console.log(`change consumer ${consumer}: retry is now due`);
            return;
          }
          if (action === "skip") {
            if (!commandOptions.through || !commandOptions.reason) {
              throw new Error("changes skip requires --through and --reason");
            }
            await contrail.changes.skip(
              consumer!,
              {
                through: commandOptions.through,
                reason: commandOptions.reason,
                confirm: commandOptions.yes === true,
              },
              db,
            );
            console.log(
              `change consumer ${consumer}: explicitly skipped through ${commandOptions.through}`,
            );
            return;
          }
          if (action === "prune") {
            const result = await contrail.changes.prune(
              {
                maxBatches: Number(commandOptions.maxBatches),
                ...(commandOptions.olderThan === undefined
                  ? {}
                  : { olderThan: Number(commandOptions.olderThan) }),
              },
              db,
            );
            console.log(
              `change log: pruned=${result.pruned} floor=${result.retainedFloor} ` +
                `safeThrough=${result.safeThrough} done=${result.done}`,
            );
            return;
          }

          const status = await contrail.changes.status(db);
          if (commandOptions.json) {
            console.log(JSON.stringify(status, null, 2));
            return;
          }
          if (!status.enabled || !status.state) {
            console.log("change log: disabled");
            return;
          }
          console.log(
            `change log: generation=${status.state.generation} head=${status.state.head} ` +
              `floor=${status.state.retainedFloor} rows=${status.rows} ` +
              `changes=${status.changes} bytes=${status.bytes}`,
          );
          for (const item of status.consumers) {
            const retry =
              item.nextAttemptAt === null
                ? "due"
                : new Date(item.nextAttemptAt).toISOString();
            console.log(
              `  ${item.id}: state=${item.bootstrapState} ` +
                `position=${item.position} backlog=${item.backlogBatches}/` +
                `${item.backlogChanges} attempts=${item.attempts} ` +
                `retry=${retry} leased=${item.leased ? "yes" : "no"}`,
            );
          }
        });
      },
    );
}
