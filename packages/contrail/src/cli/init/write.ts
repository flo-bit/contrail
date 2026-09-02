import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { findConfigFile, loadConfig } from "../../cli-config.js";
import { validateConfig, type ContrailConfig } from "../../core/types.js";
import { generateLexicons } from "../../lexicons/generate.js";
import type { InitArtifacts } from "./render.js";

export interface WrittenInitArtifacts {
  configPath: string;
  pinnedRoot: string;
  lockPath: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function lexiconPath(root: string, nsid: string): string {
  return join(root, ...nsid.split(".")) + ".json";
}

/** Stage, validate, and commit all prefix-init owned files without overwrites. */
export async function writeInitArtifacts(
  directory: string,
  artifacts: InitArtifacts,
): Promise<WrittenInitArtifacts> {
  const root = resolve(directory);
  const existingConfig = findConfigFile(root);
  if (existingConfig) {
    throw new Error(`A Contrail config already exists at ${existingConfig}`);
  }
  const configPath = join(root, "contrail.config.ts");
  const pinnedRoot = join(root, "lexicons", "pinned");
  const lockPath = join(root, "lexicons", "pinned.lock");
  for (const path of [configPath, pinnedRoot, lockPath]) {
    if (await exists(path)) {
      throw new Error(`Contrail init refuses to overwrite ${path}`);
    }
  }

  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${basename(root)}-contrail-init-`));
  const stageConfig = join(stage, "contrail.config.ts");
  const stagePinned = join(stage, "lexicons", "pinned");
  const stageLock = join(stage, "lexicons", "pinned.lock");
  try {
    await mkdir(stagePinned, { recursive: true });
    await writeFile(stageConfig, artifacts.configSource);
    for (const document of artifacts.analysis.graph.documents) {
      const path = lexiconPath(stagePinned, document.id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(document.value, null, 2)}\n`);
    }
    await writeFile(stageLock, `${JSON.stringify(artifacts.lock, null, 2)}\n`);

    const loaded = await loadConfig<ContrailConfig>(stageConfig);
    validateConfig(loaded);
    const validationOutput = join(stage, ".validation-generated");
    generateLexicons({
      config: loaded,
      rootDir: stage,
      outputDir: validationOutput,
      writeAtcuteConfig: false,
      quiet: true,
    });
    await rm(validationOutput, { recursive: true, force: true });

    // Recheck after network/staging work, then commit the config last. A caller
    // never observes a config whose pinned inputs were not installed.
    const racedConfig = findConfigFile(root);
    if (racedConfig) {
      throw new Error(`A Contrail config already exists at ${racedConfig}`);
    }
    for (const path of [pinnedRoot, lockPath]) {
      if (await exists(path)) {
        throw new Error(`Contrail init refuses to overwrite ${path}`);
      }
    }

    await mkdir(join(root, "lexicons"), { recursive: true });
    let movedPinned = false;
    let wroteLock = false;
    let wroteConfig = false;
    try {
      await rename(stagePinned, pinnedRoot);
      movedPinned = true;
      await writeFile(lockPath, await readFile(stageLock), { flag: "wx" });
      wroteLock = true;
      await writeFile(configPath, artifacts.configSource, { flag: "wx" });
      wroteConfig = true;
    } catch (error) {
      if (wroteConfig) await rm(configPath, { force: true });
      if (wroteLock) await rm(lockPath, { force: true });
      if (movedPinned) await rm(pinnedRoot, { recursive: true, force: true });
      throw error;
    }

    return { configPath, pinnedRoot, lockPath };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
