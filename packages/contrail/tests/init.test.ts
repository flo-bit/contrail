import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/cli-config";
import {
  initializeFromPrefix,
  seedConfig,
  STARTER_CONFIG,
} from "../src/cli/commands/init";

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

  it("rejects prefix initialization before making a network request when a config exists", async () => {
    const root = await temporaryRoot();
    const path = join(root, "contrail.config.ts");
    await writeFile(path, "export default { keep: true };\n");
    let requested = false;

    await expect(
      initializeFromPrefix(root, {
        prefix: "com.example.",
        fetcher: async () => {
          requested = true;
          throw new Error("must not fetch");
        },
        interactive: false,
      }),
    ).rejects.toThrow(`A Contrail config already exists at ${path}`);
    expect(requested).toBe(false);
  });

  it("initializes a complete non-interactive project from a verified prefix", async () => {
    const root = await temporaryRoot();
    const project = join(root, "prefix-project");
    const id = "com.example.note";
    const verified = {
      id,
      authorityDid: "did:plc:authority",
      uri: `at://did:plc:authority/com.atproto.lexicon.schema/${id}`,
      cid: "cid-note",
      value: {
        lexicon: 1,
        id,
        defs: {
          main: {
            type: "record",
            key: "tid",
            record: {
              type: "object",
              properties: {
                createdAt: { type: "string", format: "datetime" },
                text: { type: "string" },
                rating: { type: "integer" },
              },
            },
          },
        },
      },
      verifiedAt: "2026-08-29T00:00:00.000Z",
      verifiedUntil: "2099-08-29T00:00:00.000Z",
    };
    const fetcher: typeof fetch = async () =>
      Response.json({
        prefix: "com.example.",
        verified: true,
        snapshot: "stable",
        lexicons: [verified],
        verification: {
          candidates: 1,
          verified: 1,
          pending: 0,
          stale: 0,
          temporaryFailure: 0,
          unresolved: 0,
          invalid: 0,
          settled: true,
          allVerified: true,
        },
        indexing: {
          available: true,
          relayDiscoveryComplete: true,
          backfillsPending: 0,
          backfillsExhausted: 0,
          settled: true,
          complete: true,
        },
      });

    const result = await initializeFromPrefix(project, {
      prefix: "com.example.",
      namespace: "api.example.notes",
      fetcher,
      interactive: false,
      timeoutMs: 5_000,
    });
    expect(await loadConfig(result.configPath)).toEqual({
      namespace: "api.example.notes",
      profiles: [],
      collections: {
        note: {
          collection: id,
          validate: true,
          queryable: {
            createdAt: { type: "range" },
            text: {},
          },
        },
      },
    });
    expect(result.analysis.collections[0]!.skipped).toContainEqual({
      path: "rating",
      reason: "integer",
    });
  });
});
