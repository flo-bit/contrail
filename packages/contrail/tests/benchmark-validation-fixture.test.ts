import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Contrail, type ContrailConfig, type LexiconDoc } from "../src/index";

const BENCHMARK_DIR = resolve(process.cwd(), "../../apps/benchmark");

async function loadFixtureLexicons(): Promise<LexiconDoc[]> {
  const root = resolve(BENCHMARK_DIR, "lexicons/calendar");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .sort()
      .map(async (path) =>
        JSON.parse(await readFile(path, "utf8")) as LexiconDoc,
      ),
  );
}

describe("calendar benchmark validation fixture", () => {
  it("contains every configured collection Lexicon and transitive reference", async () => {
    const config = JSON.parse(
      await readFile(
        resolve(BENCHMARK_DIR, "configs/calendar.config.json"),
        "utf8",
      ),
    ) as ContrailConfig;
    const lexicons = await loadFixtureLexicons();

    const contrail = new Contrail({
      ...config,
      validation: { lexicons, strict: true, verifyCid: true },
    });

    expect(lexicons).toHaveLength(10);
    expect(contrail.config.validation?.lexicons).toHaveLength(10);
  });
});
