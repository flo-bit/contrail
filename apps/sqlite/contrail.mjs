import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const database = fileURLToPath(new URL("./data/contrail.sqlite", import.meta.url));
mkdirSync(dirname(database), { recursive: true });

const args = process.argv.slice(2);
if (
  (args[0] === "backfill" || args[0] === "dev") &&
  !args.includes("--sqlite") &&
  !args.includes("--temporary")
) {
  args.splice(1, 0, "--sqlite", database);
}

const result = spawnSync("contrail", args, {
  cwd: dirname(fileURLToPath(import.meta.url)),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.signal === "SIGINT" ? 0 : (result.status ?? 1);
