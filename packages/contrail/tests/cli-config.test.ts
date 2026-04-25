import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findConfigFile,
  loadConfig,
  CONFIG_CANDIDATES,
} from "../src/cli-config";

describe("findConfigFile", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "contrail-cli-config-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no candidates exist", () => {
    expect(findConfigFile(root)).toBeNull();
  });

  it("finds root-level contrail.config.ts", () => {
    const path = join(root, "contrail.config.ts");
    writeFileSync(path, "export const config = {};");
    expect(findConfigFile(root)).toBe(path);
    rmSync(path);
  });

  it("finds src/contrail.config.ts", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    const path = join(root, "src", "contrail.config.ts");
    writeFileSync(path, "export const config = {};");
    expect(findConfigFile(root)).toBe(path);
    rmSync(path);
  });

  it("finds src/lib/contrail.config.ts", () => {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    const path = join(root, "src", "lib", "contrail.config.ts");
    writeFileSync(path, "export const config = {};");
    expect(findConfigFile(root)).toBe(path);
    rmSync(path);
  });

  it("finds app/contrail.config.ts", () => {
    mkdirSync(join(root, "app"), { recursive: true });
    const path = join(root, "app", "contrail.config.ts");
    writeFileSync(path, "export const config = {};");
    expect(findConfigFile(root)).toBe(path);
    rmSync(path);
  });

  it("returns the first match in candidate order", () => {
    // Both src/ and app/ versions exist; src/ wins because it's earlier in the list.
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "app"), { recursive: true });
    const winner = join(root, "src", "contrail.config.ts");
    const loser = join(root, "app", "contrail.config.ts");
    writeFileSync(winner, "");
    writeFileSync(loser, "");
    expect(findConfigFile(root)).toBe(winner);
    rmSync(winner);
    rmSync(loser);
  });

  it("respects an explicit override path (relative to root)", () => {
    const explicit = join(root, "weird.config.ts");
    writeFileSync(explicit, "");
    expect(findConfigFile(root, "weird.config.ts")).toBe(explicit);
    rmSync(explicit);
  });

  it("returns null for an explicit path that doesn't exist", () => {
    expect(findConfigFile(root, "doesnotexist.ts")).toBeNull();
  });

  it("supports both .ts and .js variants in candidates", () => {
    expect(CONFIG_CANDIDATES).toContain("contrail.config.ts");
    expect(CONFIG_CANDIDATES).toContain("contrail.config.js");
    expect(CONFIG_CANDIDATES).toContain("src/contrail.config.ts");
  });
});

describe("loadConfig", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "contrail-load-config-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads a TS file with `export const config`", async () => {
    const path = join(root, "named.config.ts");
    writeFileSync(
      path,
      `export const config = { namespace: "com.example", collections: {} };`
    );
    const cfg = await loadConfig(path);
    expect(cfg).toEqual({ namespace: "com.example", collections: {} });
  });

  it("falls back to default export when no `config` named export", async () => {
    const path = join(root, "default.config.ts");
    writeFileSync(
      path,
      `export default { namespace: "com.default", collections: {} };`
    );
    const cfg = await loadConfig(path);
    expect(cfg).toEqual({ namespace: "com.default", collections: {} });
  });

  it("prefers named `config` over default export when both exist", async () => {
    const path = join(root, "both.config.ts");
    writeFileSync(
      path,
      `export const config = { namespace: "named", collections: {} };
       export default { namespace: "default", collections: {} };`
    );
    const cfg = await loadConfig<{ namespace: string }>(path);
    expect(cfg.namespace).toBe("named");
  });

  it("throws when no config-shaped export is found", async () => {
    const path = join(root, "broken.config.ts");
    writeFileSync(path, `export const notConfig = "wrong";`);
    await expect(loadConfig(path)).rejects.toThrow(/did not export a valid `config`/);
  });

  it("throws when config exports an object missing required fields", async () => {
    const path = join(root, "missingfields.config.ts");
    writeFileSync(path, `export const config = { foo: "bar" };`);
    await expect(loadConfig(path)).rejects.toThrow(
      /missing required fields \(namespace, collections\)/
    );
  });

  it("throws when default export is a primitive (not an object)", async () => {
    const path = join(root, "primitive.config.ts");
    writeFileSync(path, `export default "just a string";`);
    await expect(loadConfig(path)).rejects.toThrow(/did not export a `config` object/);
  });

  it("loads .js files too", async () => {
    const path = join(root, "vanilla.config.js");
    writeFileSync(
      path,
      `export const config = { namespace: "js.example", collections: {} };`
    );
    const cfg = await loadConfig(path);
    expect(cfg).toEqual({ namespace: "js.example", collections: {} });
  });
});
