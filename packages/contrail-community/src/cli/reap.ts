import type { CAC } from "cac";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Database } from "@atmo-dev/contrail-base";
import { CommunityAdapter } from "../adapter.js";
import { CredentialCipher } from "../credentials.js";
import {
  buildTombstoneOp,
  cidForOp,
  getLastOpCid,
  signTombstoneOp,
  submitTombstoneOp,
} from "../plc.js";

interface ReapOpts {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  attemptId?: string;
  allStuck?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  olderThan?: number;
  db?: string;
}

/** Minimal logger interface so `runReap` can be invoked from tests with
 *  silent stubs and from the CLI shim with `console`. */
export interface ReapLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Default idle window for `--all-stuck`: a row must have gone untouched this
 *  long before bulk reap will consider tombstoning it. Provisioning is a
 *  fast (seconds) state machine, so 30 minutes is a wide safety margin that
 *  still reaps genuinely-abandoned rows. Operators can override via
 *  `--older-than <minutes>`. */
export const DEFAULT_REAP_AGE_FLOOR_MS = 30 * 60 * 1000;

/** Where reap should read its provision_attempts rows from. Postgres (the
 *  decoupled external index) is selected by an explicit `--db <url>` or, as a
 *  convenience matching the apps/postgres deployment, a `DATABASE_URL` in the
 *  environment. Otherwise reap uses the Cloudflare D1 binding via wrangler.
 *  An explicit `--db` always wins over the env var. */
export type ReapDbSource =
  | { kind: "postgres"; url: string }
  | { kind: "d1" };

export function chooseReapDbSource(opts: {
  db?: string;
  databaseUrl?: string;
}): ReapDbSource {
  const url = opts.db ?? opts.databaseUrl;
  return url ? { kind: "postgres", url } : { kind: "d1" };
}

export interface RunReapOptions {
  adapter: CommunityAdapter;
  cipher: CredentialCipher;
  plcDirectory: string;
  fetch?: typeof fetch;
  logger: ReapLogger;
  /** Skip confirmation prompts. The CLI passes this when the user supplied
   *  --yes; tests always pass true since they don't have a TTY. */
  yes: boolean;
  attemptId?: string;
  allStuck?: boolean;
  dryRun?: boolean;
  /** Idle-age floor for `--all-stuck` (milliseconds). Rows updated more
   *  recently than this are left alone so a bulk reap can't tombstone an
   *  in-flight provision. Ignored for the single `--attempt-id` path, which
   *  is an explicit operator action on a known row. Defaults to
   *  DEFAULT_REAP_AGE_FLOOR_MS. */
  olderThanMs?: number;
}

export interface RunReapResult {
  ok: boolean;
  /** Validation/precondition error, present when ok=false. */
  error?: string;
  /** Number of rows successfully reaped (PLC tombstone submitted + archived). */
  reaped: number;
  /** Number of rows skipped because of --dry-run. */
  dryRunSkipped: number;
  /** Number of rows that errored out during reap (activated row, PLC error, etc.). */
  errors: number;
}

/** Yes/no prompt that respects --yes (auto-accept) and falls back to the
 *  provided default in non-TTY environments — the user isn't there to answer. */
async function promptYesNo(
  question: string,
  defaultYes: boolean,
  autoYes: boolean
): Promise<boolean> {
  if (autoYes) return true;
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const ans = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (ans === "") return defaultYes;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** Core reap logic, decoupled from the CAC plumbing so tests can drive it
 *  without going through `getPlatformProxy()`. */
export async function runReap(opts: RunReapOptions): Promise<RunReapResult> {
  const result: RunReapResult = {
    ok: true,
    reaped: 0,
    dryRunSkipped: 0,
    errors: 0,
  };

  // Safety default: an operator who omits the flag must NOT trigger
  // irrevocable PLC tombstones. Real action requires an explicit
  // `dryRun: false` (CLI: `--no-dry-run`).
  const dryRun = opts.dryRun ?? true;

  const hasAttemptId = !!opts.attemptId;
  const hasAllStuck = !!opts.allStuck;
  if (!hasAttemptId && !hasAllStuck) {
    return {
      ...result,
      ok: false,
      error: "Specify exactly one of --attempt-id <uuid> or --all-stuck.",
    };
  }
  if (hasAttemptId && hasAllStuck) {
    return {
      ...result,
      ok: false,
      error:
        "--attempt-id and --all-stuck are mutually exclusive; pass exactly one.",
    };
  }

  const olderThanMs = opts.olderThanMs ?? DEFAULT_REAP_AGE_FLOOR_MS;
  const rows = hasAttemptId
    ? await loadSingle(opts.adapter, opts.attemptId!)
    : await opts.adapter.listStuckAttempts(olderThanMs);

  if (rows.length === 0) {
    opts.logger.log("No stuck provision_attempts to reap.");
    return result;
  }

  for (const row of rows) {
    if (row.status === "activated") {
      opts.logger.error(
        `Refusing to reap ${row.attemptId}: status is "activated"; reap will not tombstone live communities.`
      );
      result.errors += 1;
      continue;
    }

    opts.logger.log(
      `Reaping ${row.attemptId} (did=${row.did}, status=${row.status})`
    );

    if (!row.encryptedRotationKey) {
      opts.logger.error(
        `  no encrypted_rotation_key on ${row.attemptId}; cannot sign tombstone`
      );
      result.errors += 1;
      continue;
    }

    let rotationJwk: JsonWebKey;
    try {
      const decoded = await opts.cipher.decryptString(row.encryptedRotationKey);
      rotationJwk = JSON.parse(decoded) as JsonWebKey;
    } catch (err) {
      opts.logger.error(
        `  failed to decrypt rotation key for ${row.attemptId}: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    let prev: string;
    try {
      prev = await getLastOpCid(opts.plcDirectory, row.did, {
        fetch: opts.fetch,
      });
    } catch (err) {
      opts.logger.error(
        `  failed to fetch last PLC op cid for ${row.did}: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    const unsigned = buildTombstoneOp(prev);
    const signed = await signTombstoneOp(unsigned, rotationJwk);
    const opCid = await cidForOp(signed);

    if (dryRun) {
      opts.logger.log(
        `  [dry-run] would submit tombstone (op cid=${opCid}, prev=${prev})`
      );
      result.dryRunSkipped += 1;
      continue;
    }

    if (!opts.yes) {
      const confirmed = await promptYesNo(
        `submit PLC tombstone for ${row.did}?`,
        false,
        false
      );
      if (!confirmed) {
        opts.logger.log(`  skipped ${row.attemptId} (not confirmed)`);
        continue;
      }
    }

    try {
      await submitTombstoneOp(opts.plcDirectory, row.did, signed, {
        fetch: opts.fetch,
      });
    } catch (err) {
      opts.logger.error(
        `  PLC tombstone submit failed for ${row.did}: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    try {
      await opts.adapter.archiveStuckAttempt(row.attemptId, {
        tombstoneOpCid: opCid,
      });
    } catch (err) {
      opts.logger.error(
        `  archive failed for ${row.attemptId} after tombstone submit: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    result.reaped += 1;
  }

  opts.logger.log(
    `Reaped ${result.reaped} attempts (${result.dryRunSkipped} dry-run skipped, ${result.errors} errors).`
  );
  return result;
}

async function loadSingle(
  adapter: CommunityAdapter,
  attemptId: string
): Promise<Awaited<ReturnType<CommunityAdapter["listStuckAttempts"]>>> {
  const row = await adapter.getProvisionAttempt(attemptId);
  return row ? [row] : [];
}

/** Dependency-injection shape: host CLI (contrail) loads its own config and
 *  passes the result, so contrail-community doesn't depend on contrail's
 *  cli-config infrastructure. */
export interface ReapHostDeps {
  /** Returns a contrail config; host is expected to exit(1) on its own if
   *  no config is found. The shape is opaque to reap. */
  resolveAndLoadConfig: (opts: { config?: string; root?: string }) => Promise<{
    community?: {
      plcDirectory?: string;
      masterKey: Uint8Array;
    };
  }>;
}

export function registerReap(cli: CAC, host: ReapHostDeps): void {
  cli
    .command(
      "reap",
      "Tombstone stuck provision_attempts rows in PLC and archive them"
    )
    .option("--config <path>", "Path to Contrail config file")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Use production D1 bindings")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--db <url>",
      "Postgres connection string for the decoupled external index. When set (or DATABASE_URL is in the env), reap runs against Postgres instead of the D1 binding."
    )
    .option("--attempt-id <uuid>", "Reap a single attempt by ID")
    .option(
      "--all-stuck",
      "Reap every provision_attempts row that did not reach status=activated and has been idle past --older-than"
    )
    .option(
      "--older-than <minutes>",
      "With --all-stuck, only reap rows idle at least this many minutes (guards in-flight provisions)",
      { default: DEFAULT_REAP_AGE_FLOOR_MS / 60_000 }
    )
    .option(
      "--dry-run",
      "Print what would be tombstoned without submitting to PLC (DEFAULT)"
    )
    .option(
      "--no-dry-run",
      "Actually submit tombstones to PLC. Irrevocable. Required for real runs."
    )
    .option("--yes", "Auto-confirm prompts")
    .action(async (options: ReapOpts) => {
      // Flag validation (exactly one of --attempt-id / --all-stuck) lives in
      // runReap, the testable core; the `!result.ok` branch below surfaces its
      // error and exits non-zero, so there's no second copy of it here.
      const config = await host.resolveAndLoadConfig(options);
      const community = config.community;
      if (!community) {
        console.error(
          "config.community is not set; reap requires a configured community module."
        );
        process.exit(1);
      }
      if (!community.plcDirectory) {
        console.error(
          "config.community.plcDirectory is required for `reap`."
        );
        process.exit(1);
      }

      // Run reap against the acquired db, then exit non-zero on any failure.
      const reapAndExit = async (db: Database): Promise<void> => {
        const result = await runReap({
          adapter: new CommunityAdapter(db),
          cipher: new CredentialCipher(community.masterKey),
          plcDirectory: community.plcDirectory!,
          logger: console,
          yes: !!options.yes,
          attemptId: options.attemptId,
          allStuck: options.allStuck,
          dryRun: options.dryRun,
          olderThanMs:
            options.olderThan !== undefined
              ? Number(options.olderThan) * 60_000
              : undefined,
        });
        if (!result.ok) {
          console.error(result.error);
          process.exit(1);
        }
        if (result.errors > 0) {
          process.exit(1);
        }
      };

      const source = chooseReapDbSource({
        db: options.db,
        databaseUrl: process.env.DATABASE_URL,
      });

      if (source.kind === "postgres") {
        // Decoupled external index. Build a pool, run, then close it.
        const pg = (await import("pg")).default;
        const { createPostgresDatabase } = await import(
          "@atmo-dev/contrail/postgres" as string
        );
        console.log("reap: using Postgres index");
        const pool = new pg.Pool({ connectionString: source.url });
        try {
          await reapAndExit(createPostgresDatabase(pool));
        } finally {
          await pool.end();
        }
        return;
      }

      // D1 via wrangler.
      const { getPlatformProxy } = await import("wrangler");
      const { env, dispose } = await getPlatformProxy();
      try {
        const db = (env as Record<string, unknown>)[options.binding] as
          | Database
          | undefined;
        if (!db) {
          console.error(
            `D1 binding "${options.binding}" not found in wrangler env.`
          );
          process.exit(1);
        }
        await reapAndExit(db);
      } finally {
        await dispose();
      }
    });
}
