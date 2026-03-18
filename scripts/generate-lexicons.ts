/**
 * Generates lexicon files, lex.config.js, and queryable.generated.ts from config.
 *
 * Usage: npx tsx scripts/generate-lexicons.ts
 */

import { join } from "path";
import { config } from "../src/config";
import { generateLexicons } from "../src/generate";

const ROOT_DIR = join(__dirname, "..");

generateLexicons({
  config,
  rootDir: ROOT_DIR,
  outputDir: join(ROOT_DIR, "lexicons-generated"),
  writeRuntimeFiles: true,
});
