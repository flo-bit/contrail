import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function dataModule(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/** Create a preload module that redirects one bare import before starting a
 * child CLI. This keeps undeclared transitive imports working in package
 * managers whose content-addressed links fully isolate dependency trees. */
export function createModuleRedirectRegistration(
  specifier: string,
  targetUrl: string,
): string {
  const loader = dataModule(
    `export async function resolve(specifier, context, nextResolve) {
  if (specifier === ${JSON.stringify(specifier)}) {
    return { url: ${JSON.stringify(targetUrl)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`,
  );
  return dataModule(
    `import { register } from "node:module";
register(${JSON.stringify(loader)}, import.meta.url);`,
  );
}

function runAtcute(
  action: "pull" | "generate",
  root: string,
  configPath?: string,
): void {
  const entry = require.resolve("@atcute/lex-cli");
  const cli = join(dirname(entry), "..", "cli.mjs");
  // @atcute/lex-cli 3.3.0 imports this helper but declares it only as a dev
  // dependency. Resolve Contrail's declared copy explicitly until upstream's
  // package metadata includes it as a runtime dependency.
  const registration = createModuleRedirectRegistration(
    "@atcute/uint8array",
    pathToFileURL(require.resolve("@atcute/uint8array")).href,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      registration,
      cli,
      action,
      ...(configPath ? ["--config", configPath] : []),
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Atcute lex-cli ${action} failed`);
  }
}

export function pullLexiconsWithAtcute(
  root: string,
  configPath?: string,
): void {
  runAtcute("pull", root, configPath);
}

export function generateLexiconTypesWithAtcute(root: string): void {
  runAtcute("generate", root);
}
