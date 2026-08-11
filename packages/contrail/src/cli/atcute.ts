import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function runAtcute(action: "pull" | "generate", root: string): void {
  const entry = require.resolve("@atcute/lex-cli");
  const cli = join(dirname(entry), "..", "cli.mjs");
  const result = spawnSync(process.execPath, [cli, action], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Atcute lex-cli ${action} failed`);
  }
}

export function pullLexiconsWithAtcute(root: string): void {
  runAtcute("pull", root);
}

export function generateLexiconTypesWithAtcute(root: string): void {
  runAtcute("generate", root);
}
