/**
 * Shared config-file discovery and loading for the `contrail` CLI.
 * Exported so downstream tooling can use the same auto-detect convention.
 *
 * Not for runtime use by regular contrail apps — they pass `config`
 * directly to `new Contrail(...)`. This module exists only to support
 * CLI tooling that has to discover + load a TS/JS config file off disk.
 */
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
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

/** Standard generated bundle locations used by runtime CLI commands. */
export const LEXICON_BUNDLE_CANDIDATES: readonly string[] = [
  "lexicons/generated/index.ts",
  "lexicons/generated/index.js",
  "src/lib/lexicons/index.ts",
  "src/lib/lexicons/index.js",
];

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

/** Infer the project root represented by a discovered config path. Exact
 * standard candidate locations win; an arbitrary explicitly named config falls
 * back to its containing directory. */
export function configProjectRoot(path: string): string {
  const target = resolve(path);
  const matches = CONFIG_CANDIDATES.flatMap((candidate) => {
    const depth = candidate.split("/").length;
    let root = target;
    for (let index = 0; index < depth; index++) root = dirname(root);
    return resolve(root, candidate) === target ? [{ root, depth }] : [];
  });
  matches.sort((left, right) => right.depth - left.depth);
  return matches[0]?.root ?? dirname(target);
}

/** Load a config file via jiti — handles TS + ESM + CJS transparently,
 *  no tsx/ts-node hook required. Accepts either a named export `config` or
 *  a default export. Validates the result has the minimum `ContrailConfig`
 *  shape (`namespace` + `collections`) so misnamed exports throw at load
 *  time rather than producing confusing "undefined.namespace" errors later. */
export function findLexiconBundle(root: string): string | null {
  for (const candidate of LEXICON_BUNDLE_CANDIDATES) {
    const path = join(root, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

export async function loadLexiconBundle(path: string): Promise<object[]> {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(path)) as {
    lexicons?: unknown;
    default?: unknown;
  };
  const value = mod.lexicons ??
    (mod.default as { lexicons?: unknown } | undefined)?.lexicons ??
    mod.default;
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object")) {
    throw new Error(`Lexicon bundle at ${path} did not export a \`lexicons\` array`);
  }
  return value as object[];
}

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
