import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isNsid } from "@atcute/lexicons/syntax";
import type { ContrailConfig } from "../core/types.js";
import { generateLexicons } from "../lexicons/generate.js";
import { pullLexiconsWithAtcute } from "./atcute.js";

export function defaultConsumerLexiconRoot(projectRoot: string): string {
  return existsSync(join(projectRoot, "src", "lib"))
    ? "src/lib/contrail/lexicons"
    : "src/contrail/lexicons";
}

function referencedNsids(document: object): string[] {
  const references = new Set<string>();
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string" && (key === "ref" || key === "refs")) {
      const nsid = value.split("#", 1)[0];
      if (nsid?.includes(".")) references.add(nsid);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, key === "refs" ? "refs" : undefined);
      }
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey);
      }
    }
  };
  visit(document);
  return [...references];
}

/** Stage only source documents whose complete external reference closure is
 * available. Generated methods are rebuilt against this directory so values
 * backed by an incomplete source schema become `unknown` rather than retaining
 * a dangling reference that breaks downstream type generation. */
function stageCompleteSourceLexicons(
  workspaceRoot: string,
  result: ReturnType<typeof generateLexicons>,
): string {
  const generatedIds = new Set(Object.keys(result.generated));
  const sources = new Map<string, object>();
  for (const document of result.lexicons) {
    const id = (document as { id?: unknown }).id;
    if (typeof id === "string" && !generatedIds.has(id)) {
      sources.set(id, document);
    }
  }

  const available = new Set([...generatedIds, ...sources.keys()]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, document] of sources) {
      if (referencedNsids(document).some((nsid) => !available.has(nsid))) {
        sources.delete(id);
        available.delete(id);
        changed = true;
      }
    }
  }

  const directory = join(workspaceRoot, "dev-complete");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (const [id, document] of sources) {
    if (!isNsid(id)) throw new Error(`Invalid Lexicon NSID: ${id}`);
    const path = join(directory, ...id.split(".")) + ".json";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  }
  return directory;
}

/** Resolve the exact public Lexicon bundle used by a config-backed local
 * service. Project-owned documents win over remotely pulled dependencies. */
export interface PrepareDevLexiconsOptions {
  /** Ask whether preparation may continue with documents that could not be
   * resolved. Omitted means fail closed. */
  confirmUnresolved?: (
    nsids: readonly string[],
  ) => boolean | Promise<boolean>;
  /** @internal Test seam for network resolution. */
  pullLexicons?: typeof pullLexiconsWithAtcute;
}

export async function prepareDevLexicons(
  config: ContrailConfig,
  projectRoot: string,
  workspaceRoot: string,
  clientLexiconRoot = resolve(
    projectRoot,
    defaultConsumerLexiconRoot(projectRoot),
  ),
  configRoot = projectRoot,
  options: PrepareDevLexiconsOptions = {},
): Promise<object[]> {
  const pulled = join(workspaceRoot, "dev-pulled");
  const roots = [...new Set([projectRoot, configRoot])];
  const localSourceDirs = [
    ...roots.flatMap((root) => [
      join(root, "lexicons", "custom"),
      join(root, "lexicons", "pinned"),
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
      if (await options.confirmUnresolved?.(missing)) {
        const complete = stageCompleteSourceLexicons(workspaceRoot, result);
        return generateLexicons({
          config,
          rootDir: workspaceRoot,
          outputDir: output,
          sourceDirs: [complete],
          surface: "public",
          writeAtcuteConfig: false,
          quiet: true,
        }).lexicons;
      }
      throw new Error(
        `Could not resolve configured development Lexicons: ${missing.join(", ")}`,
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
    (options.pullLexicons ?? pullLexiconsWithAtcute)(workspaceRoot, pullConfig);
  }
  throw new Error("Development Lexicon reference discovery did not converge");
}
