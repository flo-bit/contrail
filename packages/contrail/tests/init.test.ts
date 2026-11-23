import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/cli-config";
import { seedConfig, STARTER_CONFIG } from "../src/cli/commands/init";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contrail-init-"));
  roots.push(root);
  return root;
}

describe("contrail init", () => {
  it("creates a loadable starter config", async () => {
    const root = await temporaryRoot();
    const path = await seedConfig(root);

    expect(path).toBe(join(root, "contrail.config.ts"));
    expect(await readFile(path, "utf8")).toBe(STARTER_CONFIG);
    expect(await loadConfig(path)).toEqual({
      namespace: "com.example",
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          queryable: { startsAt: { type: "range" } },
        },
      },
    });
  });

  it("creates a requested directory", async () => {
    const root = await temporaryRoot();
    const nested = join(root, "my-appview");

    await expect(seedConfig(nested)).resolves.toBe(
      join(nested, "contrail.config.ts"),
    );
  });

  it("does not replace an existing config", async () => {
    const root = await temporaryRoot();
    const path = join(root, "contrail.config.ts");
    const original = "export default { keep: true };\n";
    await writeFile(path, original);

    await expect(seedConfig(root)).rejects.toThrow(
      `A Contrail config already exists at ${path}`,
    );
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("does not add a second config when a discovered config exists", async () => {
    const root = await temporaryRoot();
    const path = join(root, "src", "contrail.config.ts");
    await mkdir(join(root, "src"));
    await writeFile(path, "export default {};\n");

    await expect(seedConfig(root)).rejects.toThrow(
      `A Contrail config already exists at ${path}`,
    );
  });
});
