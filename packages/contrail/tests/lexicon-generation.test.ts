import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ContrailConfig } from "../src/core/types";
import { checkLexicons, generateLexicons } from "../src/lexicons/generate";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "contrail-lexicons-"));
  roots.push(root);
  const pulled = join(root, "lexicons", "pulled");
  const write = (nsid: string, document: object) => {
    const path = join(pulled, ...nsid.split(".")) + ".json";
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  };
  write("community.example.event", {
    lexicon: 1,
    id: "community.example.event",
    defs: {
      main: {
        type: "record",
        key: "tid",
        record: {
          type: "object",
          properties: {
            name: { type: "string" },
            startsAt: { type: "string", format: "datetime" },
          },
        },
      },
    },
  });
  write("community.example.rsvp", {
    lexicon: 1,
    id: "community.example.rsvp",
    defs: {
      main: {
        type: "record",
        key: "tid",
        record: {
          type: "object",
          properties: {
            status: {
              type: "string",
              knownValues: [
                "community.example.rsvp#going",
                "community.example.rsvp#interested",
              ],
            },
          },
        },
      },
    },
  });
  const config: ContrailConfig = {
    namespace: "example.public",
    profiles: [],
    collections: {
      event: {
        collection: "community.example.event",
        queryable: {
          name: {},
          startsAt: { type: "range" },
        },
        searchable: ["name"],
        relations: {
          rsvps: {
            collection: "rsvp",
            groupBy: "status",
            groups: {
              going: "community.example.rsvp#going",
              interested: "community.example.rsvp#interested",
            },
          },
        },
      },
      rsvp: {
        collection: "community.example.rsvp",
        queryable: { status: {} },
        references: {
          event: { collection: "event", field: "subject.uri" },
        },
      },
    },
  };
  return { root, config, pulled };
}

function parameters(document: any): Record<string, any> {
  return document.defs.main.parameters.properties;
}

describe("Contrail Lexicon generation", () => {
  it("generates the public collection API from projection config", () => {
    const { root, config } = fixture();
    const result = generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });

    expect(result.methods).toEqual([
      "example.public.event.getRecord",
      "example.public.event.listRecords",
      "example.public.rsvp.getRecord",
      "example.public.rsvp.listRecords",
    ]);
    expect(result.generated["example.public.getCursor"]).toBeUndefined();

    const event = result.generated["example.public.event.listRecords"] as any;
    const params = parameters(event);
    expect(params).toMatchObject({
      search: { type: "string" },
      name: { type: "string" },
      startsAtMin: { type: "string" },
      startsAtMax: { type: "string" },
      rsvpsCountMin: { type: "integer" },
      hydrateRsvps: { type: "integer" },
    });
    expect(params.profiles).toBeUndefined();
    expect(params.sort.knownValues).toContain("rsvpsGoingCount");
    expect(event.defs.record.properties.value.ref).toBe(
      "community.example.event#main",
    );
    expect(event.defs.hydrateRsvpsRecord.properties.value.ref).toBe(
      "community.example.rsvp#main",
    );

    const rsvp = result.generated["example.public.rsvp.listRecords"] as any;
    expect(parameters(rsvp).hydrateEvent).toMatchObject({ type: "boolean" });
    expect(rsvp.defs.refEventRecord.properties.value.ref).toBe(
      "community.example.event#main",
    );
  });

  it("respects disabled standard methods", () => {
    const { root, config } = fixture();
    config.collections.event!.methods = ["listRecords"];
    const result = generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    expect(result.generated["example.public.event.listRecords"]).toBeDefined();
    expect(result.generated["example.public.event.getRecord"]).toBeUndefined();
  });

  it("generates full-only operational methods when configured", () => {
    const { root, config } = fixture();
    config.notify = "private-secret";
    config.feeds = {
      network: { targets: ["event", "rsvp"] },
    };
    const result = generateLexicons({ config, rootDir: root, quiet: true });
    expect(result.methods).toContain("example.public.getCursor");
    expect(result.methods).toContain("example.public.getOverview");
    expect(result.methods).toContain("example.public.notifyOfUpdate");
    expect(result.methods).toContain("example.public.getFeed");
    const feed = result.generated["example.public.getFeed"] as any;
    expect(parameters(feed)).toMatchObject({
      feed: { knownValues: ["network"] },
      actor: { format: "at-identifier" },
      collection: {
        knownValues: ["community.example.event", "community.example.rsvp"],
      },
      search: { type: "string" },
      startsAtMin: { type: "string" },
      status: { type: "string" },
    });
  });

  it("writes a deterministic bundle and current Atcute configuration", () => {
    const { root, config } = fixture();
    generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    const bundle = readFileSync(
      join(root, "lexicons", "generated", "index.ts"),
      "utf8",
    );
    expect(bundle).toContain(
      'import _0 from "../pulled/community/example/event.json";',
    );
    expect(bundle).toContain("Regenerate with `contrail lexicons generate`");

    const atcute = readFileSync(join(root, "lex.config.js"), "utf8");
    expect(atcute).toContain("Generated by `contrail lexicons generate`");
    expect(atcute).toContain("generate: {");
    expect(atcute).toContain("pull: {");
    expect(atcute).toContain('"community.example.event"');
    expect(atcute).toContain('"community.example.rsvp"');
    checkLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    writeFileSync(
      join(root, "lex.config.js"),
      "// Generated by `contrail lexicons generate`. Re-run the command to update; do not edit.\n// stale\n",
    );
    expect(() =>
      checkLexicons({
        config,
        rootDir: root,
        surface: "public",
        quiet: true,
      }),
    ).toThrow("lex.config.js");
  });

  it("preserves user-owned Atcute configuration and supports opting out", () => {
    const { root, config } = fixture();
    const path = join(root, "lex.config.js");
    writeFileSync(path, "export default { mine: true };\n");

    generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    expect(readFileSync(path, "utf8")).toBe(
      "export default { mine: true };\n",
    );
    expect(() =>
      checkLexicons({
        config,
        rootDir: root,
        surface: "public",
        quiet: true,
      }),
    ).not.toThrow();

    rmSync(path);
    generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      writeAtcuteConfig: false,
      quiet: true,
    });
    expect(existsSync(path)).toBe(false);
    expect(() =>
      checkLexicons({
        config,
        rootDir: root,
        surface: "public",
        writeAtcuteConfig: false,
        quiet: true,
      }),
    ).not.toThrow();
  });

  it("adopts an exact legacy generated Atcute configuration", () => {
    const { root, config } = fixture();
    generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    const path = join(root, "lex.config.js");
    const generated = readFileSync(path, "utf8");
    writeFileSync(path, generated.slice(generated.indexOf("import ")));

    generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    expect(readFileSync(path, "utf8")).toBe(generated);
  });

  it("detects checked-in drift", () => {
    const { root, config } = fixture();
    generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    const path = join(
      root,
      "lexicons",
      "generated",
      "example",
      "public",
      "event",
      "listRecords.json",
    );
    writeFileSync(path, "{}\n");
    expect(() =>
      checkLexicons({
        config,
        rootDir: root,
        surface: "public",
        quiet: true,
      }),
    ).toThrow("generated Contrail Lexicons are stale");
  });

  it("never cleans the project root as generated output", () => {
    const { root, config } = fixture();
    const sentinel = join(root, "keep.txt");
    writeFileSync(sentinel, "keep");
    expect(() =>
      generateLexicons({
        config,
        rootDir: root,
        outputDir: ".",
        surface: "public",
        quiet: true,
      }),
    ).toThrow("must stay inside the project root");
    expect(existsSync(sentinel)).toBe(true);
  });

  it("requires authored Lexicons for custom query handlers before cleaning output", () => {
    const { root, config } = fixture();
    const output = join(root, "lexicons", "generated");
    mkdirSync(output, { recursive: true });
    const sentinel = join(output, "keep.txt");
    writeFileSync(sentinel, "keep");
    config.collections.event!.queries = {
      featured: async () => Response.json({}),
    };
    expect(() =>
      generateLexicons({ config, rootDir: root, quiet: true }),
    ).toThrow("requires a matching Lexicon");
    expect(existsSync(sentinel)).toBe(true);
  });
});
