#!/usr/bin/env node
/**
 * contrail-lex — CLI for generating lexicons from a Contrail config and
 * (optionally) typegenning them via @atcute/lex-cli.
 *
 * Usage from a consumer project:
 *
 *   contrail-lex generate [--config <path>]       # lexicon JSON only
 *   contrail-lex pull                             # wraps `lex-cli pull`
 *   contrail-lex types                            # wraps `lex-cli generate`
 *   contrail-lex all [--no-types] [--config ...]  # generate → pull → types
 *
 * Looks for a user config via --config <path>, else ./contrail.config.ts,
 * ./app/config.ts, ./src/lib/contrail/config.ts (first match wins). The
 * config file must default-export or named-export `config: ContrailConfig`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateLexicons } from "./generate.js";

type Subcommand = "generate" | "pull" | "types" | "all" | "help";

const USAGE = `contrail-lex <subcommand> [options]

Subcommands:
  generate     Emit lexicon JSON from Contrail config
  pull         Pull external lexicons (wraps \`lex-cli pull\`)
  types        Generate TS types from lexicon JSON (wraps \`lex-cli generate\`)
  all          generate → pull → generate → pull → types (full pipeline)
  help         Print this message

Options:
  --config <path>   Path to Contrail config file (TS or JS, default export
                    or named \`config\`). Default: auto-detect.
  --root <path>     Project root (where lexicons/ and node_modules/ live).
                    Default: CWD.
  --no-types        In \`all\`, skip the final type-generation step.
`;

function parseArgs(argv: string[]): {
  cmd: Subcommand;
  config?: string;
  root: string;
  withTypes: boolean;
} {
  const args = argv.slice(2);
  const cmd = (args.shift() ?? "help") as Subcommand;
  let config: string | undefined;
  let root = process.cwd();
  let withTypes = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") config = args[++i];
    else if (a === "--root") root = args[++i];
    else if (a === "--no-types") withTypes = false;
    else if (a === "-h" || a === "--help") return { cmd: "help", root, withTypes: true };
  }
  return { cmd, config, root, withTypes };
}

function findConfigFile(root: string, explicit?: string): string | null {
  if (explicit) {
    const p = resolve(root, explicit);
    return existsSync(p) ? p : null;
  }
  const candidates = [
    "contrail.config.ts",
    "contrail.config.js",
    "app/config.ts",
    "src/lib/contrail/config.ts",
  ];
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) return p;
  }
  return null;
}

async function loadConfig(path: string): Promise<unknown> {
  // TS files are loaded via `tsx` if available; otherwise fall back to the
  // Node loader (works for .js). We use dynamic import.
  if (path.endsWith(".ts") || path.endsWith(".mts")) {
    // `tsx` registers a hook when invoked via `tsx <cli.ts>`. If this CLI is
    // run through tsx (e.g. `npx tsx contrail-lex ...`), the import below
    // will just work. Otherwise we spawn a tsx child below — but dynamic
    // import is the preferred path for a programmatic config load.
    const mod = await import(pathToFileURL(path).href);
    return mod.config ?? mod.default;
  }
  const mod = await import(pathToFileURL(path).href);
  return mod.config ?? mod.default;
}

function runLexCli(args: string[], cwd: string): number {
  const result = spawnSync("npx", ["lex-cli", ...args], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

async function cmdGenerate(configPath: string, root: string): Promise<void> {
  const config = await loadConfig(configPath);
  if (!config || typeof config !== "object") {
    throw new Error(`Config at ${configPath} did not export a \`config\` object`);
  }
  generateLexicons({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: config as any,
    rootDir: root,
    outputDir: join(root, "lexicons-generated"),
    writeRuntimeFiles: true,
  });
}

async function main(): Promise<number> {
  const { cmd, config, root, withTypes } = parseArgs(process.argv);

  if (cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === "pull") return runLexCli(["pull"], root);
  if (cmd === "types") return runLexCli(["generate"], root);

  const configPath = findConfigFile(root, config);
  if (!configPath) {
    console.error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        "  contrail.config.ts | app/config.ts | src/lib/contrail/config.ts"
    );
    return 1;
  }

  if (cmd === "generate") {
    await cmdGenerate(configPath, root);
    return 0;
  }

  if (cmd === "all") {
    // Two-pass generate + pull is deliberate: the first `generate` emits any
    // record-type placeholders that `lex-cli pull` resolves, and the second
    // pass picks up the pulled data. Mirrors the historical `generate:pull`
    // script shape.
    await cmdGenerate(configPath, root);
    let rc = runLexCli(["pull"], root);
    if (rc !== 0) return rc;
    await cmdGenerate(configPath, root);
    rc = runLexCli(["pull"], root);
    if (rc !== 0) return rc;
    if (withTypes) {
      rc = runLexCli(["generate"], root);
      if (rc !== 0) return rc;
    }
    return 0;
  }

  console.error(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
