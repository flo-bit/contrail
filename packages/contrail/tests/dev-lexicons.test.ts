import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ContrailConfig } from "../src/core/types";
import { prepareDevLexicons } from "../src/cli/dev-lexicons";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeLexicon(root: string, nsid: string, document: object): void {
  const path = join(
    root,
    "src",
    "lib",
    "contrail",
    "lexicons",
    ...nsid.split("."),
  ) + ".json";
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

describe("contrail dev Lexicon preparation", () => {
  it("reuses an unpublished source Lexicon from the stable Svelte consumer root", async () => {
    const root = mkdtempSync(join(tmpdir(), "contrail-dev-lexicons-"));
    roots.push(root);
    const workspace = join(root, ".contrail");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "src", "lib"), { recursive: true });

    const collection = "social.popfeed.feed.review";
    writeLexicon(root, collection, {
      lexicon: 1,
      id: collection,
      defs: {
        main: {
          type: "record",
          key: "tid",
          record: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        },
      },
    });

    const config: ContrailConfig = {
      namespace: "test.svelte",
      profiles: [],
      collections: {
        review: { collection },
      },
    };
    const lexicons = await prepareDevLexicons(config, root, workspace);
    const ids = lexicons.map(
      (document) => (document as { id?: string }).id,
    );

    expect(ids).toContain(collection);
    expect(ids).toContain("test.svelte.review.getRecord");
    expect(ids).toContain("test.svelte.review.listRecords");
  });

  it("can continue with an unresolved collection Lexicon and generate unknown values", async () => {
    const root = mkdtempSync(join(tmpdir(), "contrail-dev-lexicons-"));
    roots.push(root);
    const workspace = join(root, ".contrail");
    mkdirSync(workspace, { recursive: true });

    const collection = "social.example.future.record";
    const config: ContrailConfig = {
      namespace: "test.future",
      profiles: [],
      collections: {
        future: { collection },
      },
    };
    const confirmed: string[][] = [];
    const lexicons = await prepareDevLexicons(
      config,
      root,
      workspace,
      undefined,
      undefined,
      {
        pullLexicons: () => {},
        confirmUnresolved: (nsids) => {
          confirmed.push([...nsids]);
          return true;
        },
      },
    );

    expect(confirmed).toEqual([[collection]]);
    expect(
      lexicons.some(
        (document) => (document as { id?: string }).id === collection,
      ),
    ).toBe(false);
    const list = lexicons.find(
      (document) =>
        (document as { id?: string }).id === "test.future.future.listRecords",
    ) as any;
    expect(list.defs.record.properties.value).toEqual({ type: "unknown" });
  });

  it("drops schemas with unresolved dependencies before generating the incomplete bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "contrail-dev-lexicons-"));
    roots.push(root);
    const workspace = join(root, ".contrail");
    mkdirSync(workspace, { recursive: true });

    const collection = "social.example.future.record";
    const dependency = "social.example.future.defs";
    const missing = "social.example.future.missing";
    writeLexicon(root, collection, {
      lexicon: 1,
      id: collection,
      defs: {
        main: {
          type: "record",
          key: "tid",
          record: {
            type: "object",
            properties: {
              subject: { type: "ref", ref: `${dependency}#main` },
            },
          },
        },
      },
    });
    writeLexicon(root, dependency, {
      lexicon: 1,
      id: dependency,
      defs: {
        main: {
          type: "object",
          properties: {
            nested: { type: "ref", ref: `${missing}#main` },
          },
        },
      },
    });
    const confirmed: string[][] = [];
    const lexicons = await prepareDevLexicons(
      {
        namespace: "test.future",
        profiles: [],
        collections: { future: { collection } },
      },
      root,
      workspace,
      undefined,
      undefined,
      {
        pullLexicons: () => {},
        confirmUnresolved: (nsids) => {
          confirmed.push([...nsids]);
          return true;
        },
      },
    );

    expect(confirmed).toEqual([[missing]]);
    expect(
      lexicons.some((document) => {
        const id = (document as { id?: string }).id;
        return id === collection || id === dependency;
      }),
    ).toBe(false);
    const list = lexicons.find(
      (document) =>
        (document as { id?: string }).id === "test.future.future.listRecords",
    ) as any;
    expect(list.defs.record.properties.value).toEqual({ type: "unknown" });

    const available = new Set(
      lexicons.map((document) => (document as { id?: string }).id),
    );
    expect(
      JSON.stringify(lexicons).includes(`\"ref\":\"${missing}#main\"`),
    ).toBe(false);
    expect(available.has(missing)).toBe(false);
  });

  it("still fails closed when continuation is declined", async () => {
    const root = mkdtempSync(join(tmpdir(), "contrail-dev-lexicons-"));
    roots.push(root);
    const workspace = join(root, ".contrail");
    mkdirSync(workspace, { recursive: true });

    await expect(
      prepareDevLexicons(
        {
          namespace: "test.future",
          profiles: [],
          collections: {
            future: { collection: "social.example.future.record" },
          },
        },
        root,
        workspace,
        undefined,
        undefined,
        {
          pullLexicons: () => {},
          confirmUnresolved: () => false,
        },
      ),
    ).rejects.toThrow("Could not resolve configured development Lexicons");
  });
});
