/**
 * Shared config-file discovery + loading for the `contrail` and
 * `contrail-lex` CLIs. Exported so downstream CLIs can use the same
 * auto-detect convention and fall back to the same list of locations.
 *
 * Not for runtime use by regular contrail apps — they pass `config`
 * directly to `new Contrail(...)`. This module exists only to support
 * CLI tooling that has to discover + load a TS/JS config file off disk.
 */
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createJiti } from "jiti";
import type { ContrailConfig } from "./core/types.js";

/** Auto-detect locations (first match wins). Keep this list small and stable —
 *  every CLI in the ecosystem walks it, so additions are cross-cutting. */
export const CONFIG_CANDIDATES: readonly string[] = [
  "contrail.config.ts",
  "contrail.config.js",
  "src/contrail.config.ts",
  "src/contrail.config.js",
  "src/lib/contrail.config.ts",
  "src/lib/contrail.config.js",
  "app/contrail.config.ts",
  "app/contrail.config.js",
];

/** Human-readable summary for CLI error messages. */
export const CONFIG_CANDIDATES_MESSAGE =
  "contrail.config.ts | src/contrail.config.ts | src/lib/contrail.config.ts | app/contrail.config.ts";

/** Find a config file by walking the auto-detect list relative to `root`.
 *  When `explicit` is passed, resolves that (relative to `root`) and checks
 *  existence — no auto-detection. Returns `null` if nothing found. */
export function findConfigFile(root: string, explicit?: string): string | null {
  if (explicit) {
    const p = resolve(root, explicit);
    return existsSync(p) ? p : null;
  }
  for (const c of CONFIG_CANDIDATES) {
    const p = join(root, c);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Load a config file via jiti — handles TS + ESM + CJS transparently,
 *  no tsx/ts-node hook required. Accepts either a named export `config` or
 *  a default export. Validates the result has the minimum `ContrailConfig`
 *  shape (`namespace` + `collections`) so misnamed exports throw at load
 *  time rather than producing confusing "undefined.namespace" errors later. */
export async function loadConfig<T = ContrailConfig>(path: string): Promise<T> {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(path)) as { config?: unknown; default?: unknown };
  const config = mod.config ?? mod.default;
  if (!config || typeof config !== "object") {
    throw new Error(`Config at ${path} did not export a \`config\` object`);
  }
  if (!("namespace" in config) || !("collections" in config)) {
    throw new Error(
      `Config at ${path} did not export a valid \`config\` — missing required fields (namespace, collections). ` +
        `Make sure your file does \`export const config: ContrailConfig = { namespace: "…", collections: {…} }\`.`
    );
  }
  return config as T;
}
