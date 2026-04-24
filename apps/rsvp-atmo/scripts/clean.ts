/**
 * Remove all generated files.
 *
 * Usage: npx tsx scripts/clean.ts
 */

import { rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  ".wrangler",
  "lex.config.js",
  "lexicons-pulled",
  "lexicons-generated",
  "src/lexicon-types",
];

for (const target of targets) {
  rmSync(join(ROOT, target), { recursive: true, force: true });
  console.log(`  removed ${target}`);
}

console.log("Done.");
