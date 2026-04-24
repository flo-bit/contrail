import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "./config";
import { generateLexicons } from "@atmo-dev/contrail-lexicons";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

generateLexicons({
  config,
  rootDir: ROOT_DIR,
  outputDir: join(ROOT_DIR, "lexicons-generated"),
  writeRuntimeFiles: true,
});
