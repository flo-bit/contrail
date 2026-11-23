import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import {
  buildRemoteD1ProxyConfig,
  findWranglerConfigPath,
  openWranglerD1,
  type WranglerModuleLike,
} from "../src/workers/wrangler";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "contrail-wrangler-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Wrangler D1 remote binding resolution", () => {
  it("builds a single-binding remote config from a wrangler.jsonc without env.production or remote: true", async () => {
    const dir = await makeTempDir();
    const wranglerPath = join(dir, "wrangler.jsonc");
    await writeFile(
      wranglerPath,
      `{
        // App config intentionally omits remote: true and env.production so local dev stays local.
        "name": "atmo-events",
        "compatibility_date": "2026-01-01",
        "d1_databases": [
          {
            "binding": "DB",
            "database_name": "atmo-events-records",
            "database_id": "2e4b6ea4-6c67-444a-b37d-73594c5b2c01",
            "preview_database_id": "11111111-1111-1111-1111-111111111111",
          },
          {
            "binding": "REPORTS_DB",
            "database_name": "atmo-events-reports",
            "database_id": "451dce30-46b2-4e2d-a09c-f7ed4ccdfc4c",
          },
        ],
        "r2_buckets": [{ "binding": "OG_IMAGES", "bucket_name": "og-images" }],
      }`,
      "utf8",
    );

    // Exercise the real Wrangler v4 config parser (JSONC comments + trailing commas).
    const { unstable_readConfig } = await import("wrangler");
    const db = createSqliteDatabase(":memory:");
    let capturedTempConfigPath: string | undefined;
    let capturedTempConfig: Record<string, unknown> | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    const disposeSpy = vi.fn(async () => {});

    const mockWrangler: WranglerModuleLike = {
      unstable_readConfig: unstable_readConfig as unknown as WranglerModuleLike["unstable_readConfig"],
      getPlatformProxy: async (options) => {
        capturedOptions = options as Record<string, unknown>;
        capturedTempConfigPath = options?.configPath;
        if (capturedTempConfigPath) {
          capturedTempConfig = JSON.parse(
            await readFile(capturedTempConfigPath, "utf8"),
          );
        }
        return { env: { DB: db }, dispose: disposeSpy };
      },
    };

    const logs: string[] = [];
    const opened = await openWranglerD1({
      remote: true,
      binding: "DB",
      root: dir,
      logger: {
        log: (...args: unknown[]) => logs.push(args.join(" ")),
        warn: () => {},
        error: () => {},
      },
      _wrangler: mockWrangler,
    });

    expect(opened.remote).toBe(true);
    expect(opened.databaseId).toBe("2e4b6ea4-6c67-444a-b37d-73594c5b2c01");
    expect(opened.databaseName).toBe("atmo-events-records");
    expect(capturedOptions).toMatchObject({
      remoteBindings: true,
      persist: false,
    });
    // Must never force environment: "production".
    expect(capturedOptions?.environment).toBeUndefined();
    expect(capturedTempConfigPath).not.toBe(wranglerPath);
    expect(capturedTempConfig).toEqual({
      name: "atmo-events",
      compatibility_date: "2026-01-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "atmo-events-records",
          database_id: "2e4b6ea4-6c67-444a-b37d-73594c5b2c01",
          remote: true,
        },
      ],
    });
    expect(logs.some((line) => line.includes("2e4b6ea4-6c67-444a-b37d-73594c5b2c01"))).toBe(true);

    await opened.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(existsSync(capturedTempConfigPath!)).toBe(false);
  });

  it("supports an explicit --env name when a Wrangler config defines environments", async () => {
    const dir = await makeTempDir();
    const wranglerPath = join(dir, "wrangler.jsonc");
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "my-app",
        compatibility_date: "2026-01-01",
        d1_databases: [
          {
            binding: "DB",
            database_name: "default-db",
            database_id: "00000000-0000-0000-0000-000000000001",
          },
        ],
        env: {
          staging: {
            d1_databases: [
              {
                binding: "DB",
                database_name: "staging-db",
                database_id: "00000000-0000-0000-0000-000000000002",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const { unstable_readConfig } = await import("wrangler");
    let tempConfig: Record<string, unknown> | undefined;
    const opened = await openWranglerD1({
      remote: true,
      binding: "DB",
      env: "staging",
      wranglerConfig: wranglerPath,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      _wrangler: {
        unstable_readConfig: unstable_readConfig as unknown as WranglerModuleLike["unstable_readConfig"],
        getPlatformProxy: async (options) => {
          tempConfig = JSON.parse(await readFile(options!.configPath!, "utf8"));
          return { env: { DB: createSqliteDatabase(":memory:") }, dispose: async () => {} };
        },
      },
    });

    expect(opened.databaseId).toBe("00000000-0000-0000-0000-000000000002");
    expect(opened.databaseName).toBe("staging-db");
    expect(tempConfig?.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "staging-db",
        database_id: "00000000-0000-0000-0000-000000000002",
        remote: true,
      },
    ]);
    await opened.dispose();
  });

  it("fails closed when remote config, binding, or database_id is missing or placeholder", () => {
    expect(() =>
      buildRemoteD1ProxyConfig({ d1_databases: [] }, "DB"),
    ).toThrow(/no Wrangler config/i);

    expect(() =>
      buildRemoteD1ProxyConfig(
        {
          configPath: "/tmp/wrangler.jsonc",
          d1_databases: [
            { binding: "OTHER_DB", database_id: "1234" },
          ],
        },
        "DB",
      ),
    ).toThrow(/No D1 binding named "DB".*Available D1 bindings: OTHER_DB/);

    expect(() =>
      buildRemoteD1ProxyConfig(
        {
          configPath: "/tmp/wrangler.jsonc",
          d1_databases: [
            { binding: "DB", database_id: "PASTE_DATABASE_ID_HERE" },
          ],
        },
        "DB",
      ),
    ).toThrow(/no valid remote database_id/i);
  });

  it("fails closed and cleans up the temp config when remote proxy startup fails", async () => {
    let tempConfigPath: string | undefined;
    const mockWrangler: WranglerModuleLike = {
      unstable_readConfig: () => ({
        name: "app",
        configPath: "/tmp/wrangler.jsonc",
        d1_databases: [
          {
            binding: "DB",
            database_name: "prod",
            database_id: "2e4b6ea4-6c67-444a-b37d-73594c5b2c01",
          },
        ],
      }),
      getPlatformProxy: async (options) => {
        tempConfigPath = options?.configPath;
        expect(existsSync(tempConfigPath!)).toBe(true);
        throw new Error("Not authenticated with Cloudflare");
      },
    };

    await expect(
      openWranglerD1({
        remote: true,
        binding: "DB",
        logger: { log: () => {}, warn: () => {}, error: () => {} },
        _wrangler: mockWrangler,
      }),
    ).rejects.toThrow(/Failed to connect to remote D1 binding "DB".*Not authenticated/);

    expect(tempConfigPath).toBeTruthy();
    expect(existsSync(tempConfigPath!)).toBe(false);
  });

  it("disables remote bindings explicitly in local mode", async () => {
    const dir = await makeTempDir();
    const wranglerPath = join(dir, "wrangler.jsonc");
    await writeFile(wranglerPath, `{"name":"local-app","d1_databases":[{"binding":"DB","remote":true}]}`, "utf8");
    expect(findWranglerConfigPath({ root: dir })).toBe(wranglerPath);

    let capturedOptions: Record<string, unknown> | undefined;
    const opened = await openWranglerD1({
      remote: false,
      binding: "DB",
      root: dir,
      env: "dev",
      _wrangler: {
        getPlatformProxy: async (options) => {
          capturedOptions = options as Record<string, unknown>;
          return { env: { DB: createSqliteDatabase(":memory:") }, dispose: async () => {} };
        },
      },
    });

    expect(opened.remote).toBe(false);
    expect(capturedOptions).toEqual({
      configPath: wranglerPath,
      environment: "dev",
      remoteBindings: false,
    });
    await opened.dispose();
  });

  it("rejects a nonexistent explicit --wrangler-config path", () => {
    expect(() =>
      findWranglerConfigPath({ wranglerConfig: "/nonexistent/wrangler.jsonc" }),
    ).toThrow(/Wrangler config file not found/);
  });

  it("exposes --remote, --binding, --env, and --wrangler-config on backfill and changes CLI commands", async () => {
    const { cac } = await import("cac");
    const { registerBackfill } = await import("../src/cli/commands/backfill");
    const { registerChanges } = await import("../src/cli/commands/changes");
    const cli = cac("contrail");
    registerBackfill(cli);
    registerChanges(cli);

    for (const name of ["backfill", "changes"]) {
      const command = cli.commands.find((c) => c.name === name);
      expect(command).toBeDefined();
      const optionNames = command!.options.map((opt) => opt.name);
      expect(optionNames).toEqual(
        expect.arrayContaining(["remote", "binding", "env", "wranglerConfig"]),
      );
    }
  });
});
