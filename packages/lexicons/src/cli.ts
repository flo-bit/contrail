#!/usr/bin/env node
/**
 * contrail-lex — CLI for generating, typegenning, and publishing lexicons.
 *
 * Usage from a consumer project:
 *
 *   contrail-lex generate [--config <path>]       # lexicon JSON only
 *   contrail-lex pull                             # wraps `lex-cli pull`
 *   contrail-lex types                            # wraps `lex-cli generate`
 *   contrail-lex all [--no-types] [--config ...]  # generate → pull → types
 *   contrail-lex publish [handle] [password]      # publish lexicons to a PDS
 *   contrail-lex pull-service <url>               # fetch lexicons from a deployed contrail
 *
 * Config auto-detects at ./contrail.config.ts, ./app/config.ts, or
 * ./src/lib/contrail/config.ts (first match wins); override with --config.
 * The file must default-export or named-export `config: ContrailConfig`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import {
  findConfigFile,
  loadConfig,
  CONFIG_CANDIDATES_MESSAGE,
} from "@atmo-dev/contrail/cli-config";
import { generateLexicons } from "./generate.js";
import { publishLexicons } from "./publish.js";

type Subcommand = "generate" | "pull" | "types" | "all" | "publish" | "pull-service" | "help";

const USAGE = `contrail-lex <subcommand> [options]

Subcommands:
  generate        Emit lexicon JSON from Contrail config
  pull            Pull external lexicons (wraps \`lex-cli pull\`)
  types           Generate TS types from lexicon JSON (wraps \`lex-cli generate\`)
  all             generate → pull → generate → pull → types (full pipeline)
  publish         Publish lexicon JSON as com.atproto.lexicon.schema records on a PDS
  pull-service    Fetch lexicons from a deployed contrail \`/lexicons\` endpoint
  help            Print this message

Options:
  --config <path>     Path to Contrail config file. Default: auto-detect.
  --root <path>       Project root (where lexicons/ and node_modules/ live). Default: CWD.
  --no-types          In \`all\`, skip the final type-generation step.
  --generated-dir     For \`publish\`: dir of JSON to publish. Default: lexicons/generated.
  --skip-confirm      For \`publish\`: skip the "do you control these zones?" prompt.
  --dry-run           For \`publish\`: print what would be published + the DNS records needed, no writes.
  --out <dir>         For \`pull-service\`: where to write fetched lexicons. Default: lexicons/pulled.
  --namespace <ns>    For \`pull-service\`: construct the URL as \`<base>/xrpc/<ns>.lexicons\`. Or pass a full URL.

Environment variables (for \`publish\`):
  LEXICON_ACCOUNT_IDENTIFIER   handle or DID (falls back to positional arg 1)
  LEXICON_ACCOUNT_PASSWORD     app password   (falls back to positional arg 2)
`;

function parseArgs(argv: string[]): {
  cmd: Subcommand;
  config?: string;
  root: string;
  withTypes: boolean;
  generatedDir: string;
  skipConfirm: boolean;
  dryRun: boolean;
  out?: string;
  namespace?: string;
  positional: string[];
} {
  const args = argv.slice(2);
  const cmd = (args.shift() ?? "help") as Subcommand;
  let config: string | undefined;
  let root = process.cwd();
  let withTypes = true;
  let generatedDir = "lexicons/generated";
  let skipConfirm = false;
  let dryRun = false;
  let out: string | undefined;
  let namespace: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") config = args[++i];
    else if (a === "--root") root = args[++i];
    else if (a === "--no-types") withTypes = false;
    else if (a === "--generated-dir") generatedDir = args[++i];
    else if (a === "--skip-confirm") skipConfirm = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--out") out = args[++i];
    else if (a === "--namespace") namespace = args[++i];
    else if (a === "-h" || a === "--help")
      return { cmd: "help", root, withTypes: true, generatedDir, skipConfirm, dryRun, out, namespace, positional };
    else positional.push(a);
  }
  return { cmd, config, root, withTypes, generatedDir, skipConfirm, dryRun, out, namespace, positional };
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
  generateLexicons({
    config,
    rootDir: root,
    outputDir: join(root, "lexicons", "generated"),
    writeRuntimeFiles: true,
  });
}

async function cmdPublish(
  root: string,
  generatedDir: string,
  positional: string[],
  skipConfirm: boolean,
  dryRun: boolean
): Promise<number> {
  const identifier = positional[0] ?? process.env.LEXICON_ACCOUNT_IDENTIFIER;
  const password = positional[1] ?? process.env.LEXICON_ACCOUNT_PASSWORD;
  if (!dryRun && (!identifier || !password)) {
    console.error(
      "missing credentials. pass positional <handle> <app-password> or set\n" +
        "LEXICON_ACCOUNT_IDENTIFIER and LEXICON_ACCOUNT_PASSWORD.\n" +
        "(not required with --dry-run)"
    );
    return 1;
  }
  const dir = resolve(root, generatedDir);
  if (!existsSync(dir)) {
    console.error(`generated lexicons dir not found: ${dir}`);
    return 1;
  }
  const result = await publishLexicons({
    generatedDir: dir,
    identifier,
    password,
    skipConfirm,
    dryRun,
  });
  if (!dryRun) {
    console.log(
      `published ${result.published} lexicon(s)` +
        (result.failed.length ? `, ${result.failed.length} failed` : "")
    );
  }
  return result.failed.length ? 1 : 0;
}

interface LexiconDoc {
  id?: string;
  [k: string]: unknown;
}

async function cmdPullService(
  root: string,
  outDir: string,
  namespace: string | undefined,
  positional: string[]
): Promise<number> {
  const url = positional[0];
  if (!url) {
    console.error("usage: contrail-lex pull-service <url> [--namespace <ns>]");
    console.error(
      "  <url> is either a full URL to the lexicon endpoint\n" +
        "    e.g. https://my-contrail.dev/xrpc/com.example.lexicons\n" +
        "  or a base URL combined with --namespace:\n" +
        "    contrail-lex pull-service https://my-contrail.dev --namespace com.example"
    );
    return 1;
  }
  let endpoint: string;
  if (url.includes("/xrpc/")) {
    endpoint = url;
  } else if (namespace) {
    endpoint = `${url.replace(/\/$/, "")}/xrpc/${namespace}.lexicons`;
  } else {
    console.error(
      "pull-service: pass a full URL containing /xrpc/<ns>.lexicons, or use --namespace <ns> to construct one."
    );
    return 1;
  }
  console.log(`fetching ${endpoint}…`);

  let docs: LexiconDoc[];
  try {
    const res = await fetch(endpoint);
    if (!res.ok) {
      console.error(`request failed: ${res.status} ${res.statusText}`);
      return 1;
    }
    const body = (await res.json()) as { lexicons?: LexiconDoc[] };
    docs = body.lexicons ?? [];
  } catch (err) {
    console.error(`fetch error: ${(err as Error).message}`);
    return 1;
  }

  if (docs.length === 0) {
    console.error(
      "no lexicons in response. the service must pass { lexicons } to createWorker() " +
        "(emit with `contrail-lex generate` and import from ./lexicons/generated)."
    );
    return 1;
  }

  const absOut = resolve(root, outDir);
  mkdirSync(absOut, { recursive: true });
  let written = 0;
  for (const doc of docs) {
    if (!doc.id || typeof doc.id !== "string") continue;
    const filePath = join(absOut, ...doc.id.split(".")) + ".json";
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n");
    written++;
  }
  console.log(`wrote ${written} lexicon(s) to ${absOut}`);
  console.log("run `npx lex-cli generate` (or `contrail-lex types`) to emit TS types.");
  return 0;
}

async function main(): Promise<number> {
  const { cmd, config, root, withTypes, generatedDir, skipConfirm, dryRun, out, namespace, positional } =
    parseArgs(process.argv);

  if (cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === "pull") return runLexCli(["pull"], root);
  if (cmd === "types") return runLexCli(["generate"], root);
  if (cmd === "publish")
    return cmdPublish(root, generatedDir, positional, skipConfirm, dryRun);
  if (cmd === "pull-service")
    return cmdPullService(root, out ?? "lexicons/pulled", namespace, positional);

  const configPath = findConfigFile(root, config);
  if (!configPath) {
    console.error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        `  ${CONFIG_CANDIDATES_MESSAGE}`
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
