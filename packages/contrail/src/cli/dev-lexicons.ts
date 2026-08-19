import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContrailConfig } from "../core/types.js";
import { generateLexicons } from "../lexicons/generate.js";
import { pullLexiconsWithAtcute } from "./atcute.js";

export function defaultConsumerLexiconRoot(projectRoot: string): string {
  return existsSync(join(projectRoot, "src", "lib"))
    ? "src/lib/contrail/lexicons"
    : "src/contrail/lexicons";
}

/** Resolve the exact public Lexicon bundle used by a config-backed local
 * service. Project-owned documents win over remotely pulled dependencies. */
export function prepareDevLexicons(
  config: ContrailConfig,
  projectRoot: string,
  workspaceRoot: string,
  clientLexiconRoot = resolve(
    projectRoot,
    defaultConsumerLexiconRoot(projectRoot),
  ),
  configRoot = projectRoot,
): object[] {
  const pulled = join(workspaceRoot, "dev-pulled");
  const roots = [...new Set([projectRoot, configRoot])];
  const localSourceDirs = [
    ...roots.flatMap((root) => [
      join(root, "lexicons", "custom"),
      join(root, "lexicons", "pulled"),
    ]),
    // A prior source connection places the complete local bundle here. Reuse
    // unpublished documents from that stable path before network resolution.
    clientLexiconRoot,
  ];
  const sourceDirs = [...localSourceDirs, pulled];
  const output = join(workspaceRoot, "dev-lexicons");
  const pullConfig = join(workspaceRoot, "dev-pull.config.mjs");
  let attempted: string | null = null;

  for (let pass = 0; pass < 5; pass++) {
    const result = generateLexicons({
      config,
      rootDir: workspaceRoot,
      outputDir: output,
      sourceDirs,
      surface: "public",
      writeAtcuteConfig: false,
      quiet: true,
    });
    const available = new Set(
      result.lexicons
        .map((document) => (document as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );
    const missing = result.pullNsids.filter((nsid) => !available.has(nsid));
    if (missing.length === 0) return result.lexicons;

    const current = JSON.stringify(missing);
    if (current === attempted) {
      throw new Error(
        `Could not resolve required development Lexicons: ${missing.join(", ")}`,
      );
    }
    attempted = current;
    const remoteNsids = result.pullNsids.filter((nsid) => {
      const relativePath = `${nsid.split(".").join("/")}.json`;
      return !localSourceDirs.some((directory) =>
        existsSync(join(directory, relativePath)),
      );
    });
    writeFileSync(
      pullConfig,
      `export default ${JSON.stringify(
        {
          pull: {
            outdir: "dev-pulled",
            clean: true,
            sources: [{ type: "atproto", mode: "nsids", nsids: remoteNsids }],
          },
        },
        null,
        2,
      )};\n`,
    );
    console.log(`lexicons: resolving ${missing.join(", ")}`);
    pullLexiconsWithAtcute(workspaceRoot, pullConfig);
  }
  throw new Error("Development Lexicon reference discovery did not converge");
}
