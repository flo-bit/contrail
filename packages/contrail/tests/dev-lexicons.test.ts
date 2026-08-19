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
  it("reuses an unpublished source Lexicon from the stable Svelte consumer root", () => {
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
    const lexicons = prepareDevLexicons(config, root, workspace);
    const ids = lexicons.map(
      (document) => (document as { id?: string }).id,
    );

    expect(ids).toContain(collection);
    expect(ids).toContain("test.svelte.review.getRecord");
    expect(ids).toContain("test.svelte.review.listRecords");
  });
});
