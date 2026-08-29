import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CAC } from "cac";
import { findConfigFile } from "../../cli-config.js";
import {
  analyzeLexiconGraph,
  buildLexiconGraph,
  type PrefixAnalysis,
} from "../init/analyze.js";
import {
  DEFAULT_LEXICON_API,
  fetchExactLexicon,
  importLexiconPrefix,
  type RegistryClientOptions,
} from "../init/registry.js";
import {
  promptReferenceChoices,
  type ReferenceChoice,
  type SemanticChoicePrompt,
} from "../init/references.js";
import { createInitArtifacts } from "../init/render.js";
import { writeInitArtifacts } from "../init/write.js";

export const STARTER_CONFIG = `export default {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { startsAt: { type: "range" } },
    },
  },
};
`;

/** Create a starter config without replacing an existing Contrail config. */
export async function seedConfig(directory: string): Promise<string> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });

  const existing = findConfigFile(root);
  if (existing) {
    throw new Error(`A Contrail config already exists at ${existing}`);
  }

  const path = join(root, "contrail.config.ts");
  try {
    await writeFile(path, STARTER_CONFIG, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`A Contrail config already exists at ${path}`);
    }
    throw error;
  }
  return path;
}

export interface PrefixInitOptions extends RegistryClientOptions {
  prefix: string;
  namespace?: string;
  interactive?: boolean;
  prompt?: SemanticChoicePrompt;
}

export interface PrefixInitResult {
  configPath: string;
  lockPath: string;
  analysis: PrefixAnalysis;
  choices: ReferenceChoice[];
}

/** Registry-backed initializer, kept injectable for deterministic tests. */
export async function initializeFromPrefix(
  directory: string,
  options: PrefixInitOptions,
): Promise<PrefixInitResult> {
  const root = resolve(directory);
  const existing = findConfigFile(root);
  if (existing) {
    throw new Error(`A Contrail config already exists at ${existing}`);
  }

  const registryOptions: RegistryClientOptions = {
    api: options.api,
    timeoutMs: options.timeoutMs,
    allowPartial: options.allowPartial,
    fetcher: options.fetcher,
    now: options.now,
    sleep: options.sleep,
  };
  const prefix = await importLexiconPrefix(options.prefix, registryOptions);
  const graph = await buildLexiconGraph(prefix, (nsid) =>
    fetchExactLexicon(nsid, registryOptions),
  );
  const analysis = analyzeLexiconGraph(graph);
  const choices =
    options.interactive === false
      ? []
      : await (options.prompt ?? promptReferenceChoices)(analysis);
  const artifacts = createInitArtifacts(
    options.namespace ?? "com.example",
    analysis,
    choices,
  );
  const written = await writeInitArtifacts(root, artifacts);
  return {
    configPath: written.configPath,
    lockPath: written.lockPath,
    analysis,
    choices,
  };
}

interface InitCliOptions {
  prefix?: string;
  namespace: string;
  lexiconApi: string;
  timeout: number;
  allowPartial?: boolean;
  interactive?: boolean;
}

function positiveSeconds(value: number): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TypeError("--timeout must be a positive number of seconds");
  }
  return seconds;
}

function printPrefixSummary(result: PrefixInitResult): void {
  const fields = result.analysis.collections.reduce(
    (total, collection) => total + Object.keys(collection.queryable).length,
    0,
  );
  const skipped = result.analysis.collections.reduce(
    (total, collection) => total + collection.skipped.length,
    0,
  );
  const candidates = result.analysis.collections.reduce(
    (total, collection) => total + collection.references.length,
    0,
  );
  const dependencies = result.analysis.graph.documents.filter(
    (document) => document.role === "dependency",
  ).length;
  const unresolvedLinks = Math.max(0, candidates - result.choices.length);
  console.log(
    `Imported ${result.analysis.graph.prefix.prefix} from ${result.analysis.graph.prefix.api}`,
  );
  console.log(`  ${result.analysis.collections.length} record collections`);
  console.log(`  ${dependencies} pinned dependency documents`);
  console.log(`  ${fields} queryable fields / expression indexes`);
  if (skipped > 0) console.log(`  ${skipped} unsupported fields skipped`);
  if (result.choices.length > 0) {
    const inverse = result.choices.filter((choice) => choice.inverse).length;
    console.log(
      `  ${result.choices.length} references, ${inverse} inverse relations configured`,
    );
  }
  if (unresolvedLinks > 0) {
    console.log(`  ${unresolvedLinks} reference candidates left unconfigured`);
  }
  const safeBsky = result.analysis.collections.filter((collection) =>
    collection.nsid.startsWith("app.bsky."),
  );
  if (safeBsky.length > 0) {
    console.warn(
      `  warning: ${safeBsky.length} app.bsky.* collections retain discover:false safety defaults`,
    );
  }
  if (result.analysis.graph.prefix.partial) {
    console.warn("  warning: the registry import is partial");
  }
  console.log(`Created ${relative(process.cwd(), result.configPath) || "contrail.config.ts"}`);
  console.log(`Created ${relative(process.cwd(), result.lockPath)}`);
  console.log("\nRun: contrail dev");
}

export function registerInit(cli: CAC): void {
  cli
    .command(
      "init [directory]",
      "Create a starter config or import verified Lexicons by prefix",
    )
    .option("--prefix <prefix>", "Verified Lexicon prefix to import")
    .option("--namespace <namespace>", "Generated AppView XRPC namespace", {
      default: "com.example",
    })
    .option("--lexicon-api <url>", "atmo Lexicons API origin", {
      default: DEFAULT_LEXICON_API,
    })
    .option("--timeout <seconds>", "Registry readiness timeout", {
      default: 60,
    })
    .option(
      "--allow-partial",
      "Accept incomplete prefix verification or catalog indexing",
    )
    .option(
      "--no-interactive",
      "Skip ambiguous reference and inverse-relation questions",
    )
    .action(async (directory: string | undefined, options: InitCliOptions) => {
      const root = directory ?? process.cwd();
      if (!options.prefix) {
        const path = await seedConfig(root);
        const displayPath = relative(process.cwd(), path) || "contrail.config.ts";
        console.log(`Created ${displayPath}`);
        return;
      }
      const result = await initializeFromPrefix(root, {
        prefix: options.prefix,
        namespace: options.namespace,
        api: options.lexiconApi,
        timeoutMs: positiveSeconds(options.timeout) * 1_000,
        allowPartial: options.allowPartial,
        interactive: options.interactive,
      });
      printPrefixSummary(result);
    });
}
