import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CAC } from "cac";
import { findConfigFile } from "../../cli-config.js";

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

export function registerInit(cli: CAC): void {
  cli
    .command("init [directory]", "Create a starter contrail.config.ts")
    .action(async (directory: string | undefined) => {
      const path = await seedConfig(directory ?? process.cwd());
      const displayPath = relative(process.cwd(), path) || "contrail.config.ts";
      console.log(`Created ${displayPath}`);
    });
}
