import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
    orderedSource: { source: "jetstream", epoch: "test-primary" },
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
  return { root, config, pulled, write };
}

function parameters(document: any): Record<string, any> {
  return document.defs.main.parameters.properties;
}

describe("Contrail Lexicon generation", () => {
  it("types self declarations on all generated views and includes the offline label defs fallback", () => {
    const { root, config } = fixture();
    config.profiles = [{ collection: "community.example.profile" }];
    config.feeds = { network: { targets: ["event"] } };
    const result = generateLexicons({ config, rootDir: root, quiet: true });
    expect(result.generated["com.atproto.label.defs"]).toBeDefined();
    expect(result.lexicons.some((doc: any) => doc.id === "com.atproto.label.defs")).toBe(true);
    const property = { type: "array", maxLength: 10,
      items: { type: "ref", ref: "com.atproto.label.defs#selfLabel" } };
    const list = result.generated["example.public.event.listRecords"] as any;
    expect(list.defs.record.properties.selfLabels).toMatchObject(property);
    expect(list.defs.hydrateRsvpsRecord.properties.selfLabels).toMatchObject(property);
    expect(list.defs.profileEntry.properties.selfLabels).toMatchObject(property);
    const rsvp = result.generated["example.public.rsvp.listRecords"] as any;
    expect(rsvp.defs.refEventRecord.properties.selfLabels).toMatchObject(property);
    const get = result.generated["example.public.event.getRecord"] as any;
    expect(get.defs.main.output.schema.properties.selfLabels).toMatchObject(property);
    const profile = result.generated["example.public.getProfile"] as any;
    expect(profile.defs.profileEntry.properties.selfLabels).toMatchObject(property);
    const feed = result.generated["example.public.getFeed"] as any;
    expect(feed.defs.feedRecordEvent.properties.selfLabels).toMatchObject(property);
  });
  it("prefers project-provided standard label definitions over the offline fallback", () => {
    const { root, config, write } = fixture();
    const provided = { lexicon: 1, id: "com.atproto.label.defs", defs: {
      selfLabel: { type: "object", required: ["val"], properties: { val: { type: "string", maxLength: 128 } },
        description: "Project-pinned standard definition" },
    } };
    write("com.atproto.label.defs", provided);
    const result = generateLexicons({ config, rootDir: root, quiet: true });
    expect(result.generated["com.atproto.label.defs"]).toBeUndefined();
    expect(result.lexicons.find((doc: any) => doc.id === "com.atproto.label.defs")).toEqual(provided);
  });
  it("generates moderation records and method-bound private routes", () => {
    const { root, config } = fixture();
    const result = generateLexicons({ config: { ...config,
      moderation: { moderators: ["did:plc:moderator"] },
      serviceAuth: { audience: "did:web:api.example.com#contrail", methods: [] },
    }, rootDir: root, quiet: true });
    expect(result.generated["tools.atmo.moderation.action"]).toMatchObject({ defs: { main: { type: "record", key: "tid" } } });
    expect(result.methods).toContain("com.atproto.moderation.createReport");
    expect(result.methods).toContain("example.public.moderation.listReports");
    expect(result.methods).toContain("example.public.moderation.resolveReport");
  });
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
      "example.public.getCursor",
      "example.public.rsvp.getRecord",
      "example.public.rsvp.listRecords",
    ]);
    expect(result.generated["example.public.getCursor"]).toBeDefined();
    expect(
      (result.generated["example.public.getCursor"] as any).defs.sourcePosition
        .required,
    ).toEqual(["source", "epoch", "cursor"]);

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

  it("references profile record schemas without duplicating their definitions", () => {
    const { root, config, write } = fixture();
    write("community.example.profile", {
      lexicon: 1,
      id: "community.example.profile",
      defs: {
        main: {
          type: "record",
          key: "literal:self",
          record: {
            type: "object",
            properties: { displayName: { type: "string" } },
          },
        },
      },
    });
    config.profiles = [
      { collection: "community.example.profile", shortName: "profile" },
    ];
    const result = generateLexicons({ config, rootDir: root, quiet: true });
    const profile = result.generated["example.public.getProfile"] as any;
    expect(profile.defs.profileEntry.properties.value).toEqual({
      type: "ref",
      ref: "community.example.profile#main",
    });
    expect(profile.defs.communityExampleProfile).toBeUndefined();
    expect(result.generated["example.public.profile.getRecord"]).toBeUndefined();
    expect(result.generated["example.public.profile.listRecords"]).toBeUndefined();
  });

  it("publishes an unscoped v2 seq cursor without an ordered source", () => {
    const { root, config } = fixture();
    delete config.orderedSource;
    const result = generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    const cursor = result.generated["example.public.getCursor"] as any;
    expect(cursor.defs.sourcePosition).toBeUndefined();
    expect(cursor.defs.main.output.schema.properties).toEqual({
      cursor: { type: "integer" },
    });
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
    expect(result.methods).not.toContain("example.public.getOverview");
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

  it("writes and returns a deterministic complete service bundle without touching lex.config.js", () => {
    const { root, config } = fixture();
    const result = generateLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
    expect(
      result.lexicons.map((document) => (document as { id: string }).id),
    ).toContain("community.example.event");
    const bundle = readFileSync(
      join(root, "lexicons", "generated", "index.ts"),
      "utf8",
    );
    expect(bundle).toContain(
      'import _0 from "../pulled/community/example/event.json";',
    );
    expect(bundle).toContain("Regenerate with `contrail lexicons generate`");
    expect(existsSync(join(root, "lex.config.js"))).toBe(false);

    checkLexicons({
      config,
      rootDir: root,
      surface: "public",
      quiet: true,
    });
  });

  it("bundles pinned sources into the generated index", () => {
    const { root, config } = fixture();
    const source = join(
      root,
      "lexicons",
      "pulled",
      "community",
      "example",
      "event.json",
    );
    const target = join(
      root,
      "lexicons",
      "pinned",
      "community",
      "example",
      "event.json",
    );
    mkdirSync(join(target, ".."), { recursive: true });
    renameSync(source, target);

    generateLexicons({ config, rootDir: root, quiet: true });
    const bundle = readFileSync(
      join(root, "lexicons", "generated", "index.ts"),
      "utf8",
    );
    expect(bundle).toContain(
      'import _0 from "../pinned/community/example/event.json";',
    );
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
