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
      "Private change-log operations: status, retry <consumer>",
    ),
  )
    .option("--json", "Print machine-readable status JSON")
    .action(
      async (
        action: string,
        consumer: string | undefined,
        commandOptions: ChangeCommandOptions,
      ) => {
        if (action !== "status" && action !== "retry") {
          throw new Error("changes action must be 'status' or 'retry'");
        }
        if (action === "retry" && !consumer) {
          throw new Error("changes retry requires a consumer ID");
        }
        if (action === "status" && consumer) {
          throw new Error("changes status does not accept a consumer ID");
        }

        await withChangesDatabase(commandOptions, async (contrail, db) => {
          if (action === "retry") {
            await contrail.changes.retry(consumer!, undefined, db);
            console.log(`change consumer ${consumer}: retry is now due`);
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
