/**
 * Wrangler v4 D1 binding loader shared by CLI commands (`contrail backfill`,
 * `contrail changes`) and `@atmo-dev/contrail/workers`.
 *
 * Wrangler v4's `getPlatformProxy()` only connects a D1 binding remotely when
 * that binding explicitly has `"remote": true` in the loaded config — passing
 * `environment: "production"` neither enables remote bindings nor works when a
 * project has no `env.production` block.
 *
 * When `remote: true` is requested, this helper reads the project's Wrangler
 * config (supporting `--env` and `--wrangler-config` / `--root`), validates the
 * target D1 binding and its `database_id`, writes an isolated temporary
 * `wrangler.json` containing only that D1 binding with `remote: true` (and
 * without `preview_database_id`), and opens `getPlatformProxy` against it with
 * `remoteBindings: true` and `persist: false`. It fails closed if no config,
 * binding, `database_id`, or remote proxy connection can be established.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "../core/types.js";

const MIN_REMOTE_WRANGLER_MAJOR = 4;
const MIN_REMOTE_WRANGLER_MINOR = 37;
const MIN_REMOTE_WRANGLER_VERSION = `${MIN_REMOTE_WRANGLER_MAJOR}.${MIN_REMOTE_WRANGLER_MINOR}.0`;

const WRANGLER_CONFIG_CANDIDATES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
] as const;

const PLACEHOLDER_DATABASE_IDS = new Set([
  "PASTE_DATABASE_ID_HERE",
  "YOUR_DATABASE_ID",
  "local",
  "placeholder",
]);

export interface WranglerD1BindingConfig {
  binding: string;
  database_name?: string;
  database_id?: string;
  preview_database_id?: string;
  remote?: boolean;
}

export interface WranglerResolvedConfig {
  name?: string;
  configPath?: string;
  compatibility_date?: string;
  account_id?: string;
  compliance_region?: string;
  d1_databases?: WranglerD1BindingConfig[];
}

export interface WranglerModuleLike {
  getPlatformProxy: (options?: {
    environment?: string;
    configPath?: string;
    persist?: boolean | { path: string };
    remoteBindings?: boolean;
  }) => Promise<{
    env: Record<string, unknown>;
    dispose: () => Promise<void>;
  }>;
  unstable_readConfig?: (args: {
    config?: string;
    env?: string;
  }) => WranglerResolvedConfig;
  startRemoteProxySession?: unknown;
}

export interface OpenWranglerD1Options {
  /** Connect to the remote Cloudflare D1 database instead of local `.wrangler/state`. */
  remote?: boolean;
  /** Name of the D1 binding in wrangler config. Default: `"DB"`. */
  binding?: string;
  /** Optional Wrangler environment name (e.g. `"staging"`). */
  env?: string;
  /** Optional explicit path to `wrangler.jsonc` / `wrangler.json` / `wrangler.toml`. */
  wranglerConfig?: string;
  /** Optional project root directory used to find a Wrangler config when `wranglerConfig` is omitted. */
  root?: string;
  /** Optional logger for connection status messages. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** @internal Test seam to inject a mock `wrangler` module. */
  _wrangler?: WranglerModuleLike;
  /** @internal Test seam to override the detected `wrangler` version string. */
  _wranglerVersion?: string;
}

export interface OpenedWranglerD1 {
  db: Database;
  binding: string;
  remote: boolean;
  databaseId?: string;
  databaseName?: string;
  dispose: () => Promise<void>;
}

/** Check whether a semver string meets the minimum Wrangler version with
 * `getPlatformProxy({ remoteBindings: true })` support (`>= 4.37.0`). */
export function supportsWranglerRemoteBindings(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MIN_REMOTE_WRANGLER_MAJOR ||
    (major === MIN_REMOTE_WRANGLER_MAJOR && minor >= MIN_REMOTE_WRANGLER_MINOR)
  );
}

function readInstalledWranglerVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("wrangler/package.json") as { version?: unknown };
    return typeof pkg?.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function assertRemoteWranglerSupport(
  wrangler: WranglerModuleLike,
  explicitVersion: string | undefined,
  isMock: boolean,
): void {
  if (typeof wrangler.unstable_readConfig !== "function") {
    throw new Error(
      `Cannot use --remote: installed wrangler does not expose unstable_readConfig (requires wrangler >= ${MIN_REMOTE_WRANGLER_VERSION}).`,
    );
  }
  const version =
    explicitVersion !== undefined
      ? explicitVersion
      : isMock
        ? undefined
        : readInstalledWranglerVersion();
  if (version !== undefined) {
    if (!supportsWranglerRemoteBindings(version)) {
      throw new Error(
        `Cannot use --remote: installed wrangler ${version} does not support remoteBindings ` +
          `(requires wrangler >= ${MIN_REMOTE_WRANGLER_VERSION}). Upgrade wrangler so --remote cannot silently fall back to local storage.`,
      );
    }
    return;
  }
  if (!isMock && typeof wrangler.startRemoteProxySession !== "function") {
    throw new Error(
      `Cannot use --remote: could not verify remoteBindings support in the installed wrangler ` +
        `(requires wrangler >= ${MIN_REMOTE_WRANGLER_VERSION}).`,
    );
  }
}

/** Locate a Wrangler config file from an explicit path or project root.
 * An explicit `--wrangler-config` fails closed if missing; `--root` falls back
 * to Wrangler's own CWD discovery when no Wrangler config sits at `--root`
 * (supporting split monorepo layouts where Contrail config is at repo root). */
export function findWranglerConfigPath(options: {
  wranglerConfig?: string;
  root?: string;
}): string | undefined {
  if (options.wranglerConfig) {
    const explicit = resolve(options.wranglerConfig);
    if (!existsSync(explicit)) {
      throw new Error(`Wrangler config file not found: ${explicit}`);
    }
    return explicit;
  }
  if (options.root) {
    const rootDir = resolve(options.root);
    for (const candidate of WRANGLER_CONFIG_CANDIDATES) {
      const fullPath = join(rootDir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return undefined;
}

function isPlaceholderDatabaseId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_DATABASE_IDS.has(trimmed)) return true;
  return /^<.*>$/.test(trimmed) || /^xxx+$/i.test(trimmed);
}

/** Validate and build the minimal Wrangler JSON config used to open a single
 * remote D1 binding without modifying the user's checked-in config file. */
export function buildRemoteD1ProxyConfig(
  resolved: WranglerResolvedConfig,
  binding: string,
  env?: string,
): {
  config: Record<string, unknown>;
  databaseId: string;
  databaseName?: string;
} {
  if (!resolved.configPath) {
    throw new Error(
      "Cannot use --remote: no Wrangler config (wrangler.jsonc, wrangler.json, or wrangler.toml) was found. " +
        "Run from your Worker directory or pass --wrangler-config <path>.",
    );
  }
  const databases = resolved.d1_databases ?? [];
  const target = databases.find((entry) => entry.binding === binding);
  if (!target) {
    const available = databases.map((entry) => entry.binding).filter(Boolean);
    const hint =
      available.length > 0
        ? ` Available D1 bindings: ${available.join(", ")}.`
        : " No d1_databases bindings are defined in this config.";
    throw new Error(
      `No D1 binding named "${binding}" in ${resolved.configPath}` +
        `${env ? ` (env "${env}")` : ""}.${hint}`,
    );
  }
  const databaseId = typeof target.database_id === "string" ? target.database_id.trim() : "";
  if (!databaseId || isPlaceholderDatabaseId(databaseId)) {
    throw new Error(
      `D1 binding "${binding}" in ${resolved.configPath}` +
        `${env ? ` (env "${env}")` : ""} has no valid remote database_id` +
        `${databaseId ? ` (got "${databaseId}")` : ""}. ` +
        `Create a remote D1 database with \`wrangler d1 create\` and set its database_id first.`,
    );
  }

  const d1Entry: Record<string, unknown> = {
    binding: target.binding,
    database_id: databaseId,
    // Intentionally omit `preview_database_id` so Wrangler always connects to
    // the real `database_id`, and force `remote: true` for this ephemeral proxy.
    remote: true,
  };
  if (target.database_name) {
    d1Entry.database_name = target.database_name;
  }

  const config: Record<string, unknown> = {
    name: resolved.name ?? "contrail-remote",
    compatibility_date: resolved.compatibility_date ?? "2026-01-01",
    d1_databases: [d1Entry],
  };
  if (resolved.account_id) config.account_id = resolved.account_id;
  if (resolved.compliance_region) config.compliance_region = resolved.compliance_region;

  return {
    config,
    databaseId,
    databaseName: target.database_name,
  };
}

/** Open a Wrangler-backed D1 binding (local `.wrangler/state` or fail-closed remote D1). */
export async function openWranglerD1(
  opts: OpenWranglerD1Options,
): Promise<OpenedWranglerD1> {
  const wrangler: WranglerModuleLike =
    opts._wrangler ?? ((await import("wrangler")) as unknown as WranglerModuleLike);
  const binding = opts.binding ?? "DB";
  const configPath = findWranglerConfigPath({
    wranglerConfig: opts.wranglerConfig,
    root: opts.root,
  });

  if (opts.remote) {
    assertRemoteWranglerSupport(
      wrangler,
      opts._wranglerVersion,
      opts._wrangler !== undefined,
    );
    const resolved = wrangler.unstable_readConfig!({
      config: configPath,
      env: opts.env,
    });
    const { config, databaseId, databaseName } = buildRemoteD1ProxyConfig(
      resolved,
      binding,
      opts.env,
    );

    const tempDir = await mkdtemp(join(tmpdir(), "contrail-wrangler-remote-"));
    const tempConfigPath = join(tempDir, "wrangler.json");
    const cleanupTemp = () => rm(tempDir, { recursive: true, force: true }).catch(() => {});

    try {
      await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      (opts.logger ?? console).log(
        `[wrangler] connecting to remote D1 binding "${binding}" ` +
          `(${databaseName ?? databaseId}, id=${databaseId}` +
          `${opts.env ? `, env=${opts.env}` : ""}` +
          `${resolved.configPath ? `, config=${resolved.configPath}` : ""})`,
      );

      let proxy: Awaited<ReturnType<WranglerModuleLike["getPlatformProxy"]>>;
      try {
        proxy = await wrangler.getPlatformProxy({
          configPath: tempConfigPath,
          remoteBindings: true,
          persist: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to connect to remote D1 binding "${binding}" (id=${databaseId}). ` +
            `Confirm you are logged in (\`wrangler whoami\`) and have access to this database. ` +
            `Cause: ${message}`,
          { cause: error },
        );
      }

      const db = proxy.env[binding] as Database | undefined;
      if (!db) {
        await proxy.dispose();
        throw new Error(
          `Remote proxy started without D1 binding "${binding}" (id=${databaseId}); refusing to fall back to local storage.`,
        );
      }

      return {
        db,
        binding,
        remote: true,
        databaseId,
        databaseName,
        dispose: async () => {
          try {
            await proxy.dispose();
          } finally {
            await cleanupTemp();
          }
        },
      };
    } catch (error) {
      await cleanupTemp();
      throw error;
    }
  }

  // Local mode: disable remote bindings explicitly so local commands never
  // accidentally mutate production D1 if a config sets `remote: true`.
  const proxy = await wrangler.getPlatformProxy({
    configPath,
    environment: opts.env,
    remoteBindings: false,
  });
  const db = proxy.env[binding] as Database | undefined;
  if (!db) {
    await proxy.dispose();
    throw new Error(
      `No binding named "${binding}" in wrangler env. Add a d1_databases ` +
        `entry to wrangler.jsonc, or pass --binding <name>.`,
    );
  }
  return {
    db,
    binding,
    remote: false,
    dispose: () => proxy.dispose(),
  };
}
