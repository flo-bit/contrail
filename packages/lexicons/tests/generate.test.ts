import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { generateLexicons, extractXrpcMethods, listXrpcMethods } from "../src/generate";
import type { ContrailConfig } from "@atmo-dev/contrail";

const ROOT_DIR = join(__dirname, "..");

function getParams(lexicon: any): Record<string, any> {
  return lexicon?.defs?.main?.parameters?.properties ?? {};
}

function getInputSchema(lexicon: any): any {
  return lexicon?.defs?.main?.input?.schema;
}

function getOutputSchema(lexicon: any): any {
  return lexicon?.defs?.main?.output?.schema;
}

function generate(config: ContrailConfig) {
  return generateLexicons({
    config,
    rootDir: ROOT_DIR,
    lexiconDirs: [],
    quiet: true,
  });
}

// --- Test configs ---

const BASIC_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    post: {
      collection: "com.example.post",
      queryable: {
        title: {},
        body: {},
        createdAt: { type: "range" },
      },
    },
  },
};

const RELATIONS_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    post: {
      collection: "com.example.post",
      queryable: { title: {} },
      relations: {
        likes: {
          collection: "like",
        },
      },
    },
    like: {
      collection: "com.example.like",
      queryable: { status: {} },
      references: {
        post: {
          collection: "post",
          field: "subject.uri",
        },
      },
    },
  },
};

const SEARCH_EXPLICIT_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    post: {
      collection: "com.example.post",
      queryable: {
        title: {},
        body: {},
        category: {},
        createdAt: { type: "range" },
      },
      searchable: ["title", "body"],
    },
  },
};

const SEARCH_DISABLED_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    post: {
      collection: "com.example.post",
      queryable: { title: {}, body: {} },
      searchable: false,
    },
  },
};

const SEARCH_AUTO_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    post: {
      collection: "com.example.post",
      queryable: {
        title: {},
        body: {},
        score: { type: "range" },
      },
    },
  },
};

describe("basic generation", () => {
  let lexicons: Record<string, any>;

  beforeAll(() => {
    lexicons = generate(BASIC_CONFIG);
  });

  it("generates admin endpoints", () => {
    expect(lexicons["test.app.getCursor"]).toBeDefined();
    expect(lexicons["test.app.getOverview"]).toBeDefined();
  });

  it("generates getProfile", () => {
    const lex = lexicons["test.app.getProfile"];
    expect(lex).toBeDefined();
    const params = getParams(lex);
    expect(params.actor).toBeDefined();
    expect(params.actor.format).toBe("at-identifier");
  });

  it("generates notifyOfUpdate as a procedure", () => {
    const lex = lexicons["test.app.notifyOfUpdate"];
    expect(lex).toBeDefined();
    expect(lex.defs.main.type).toBe("procedure");

    const input = getInputSchema(lex);
    expect(input.properties.uri).toBeDefined();
    expect(input.properties.uri.format).toBe("at-uri");
    expect(input.properties.uris.type).toBe("array");
    expect(input.properties.uris.maxLength).toBe(25);

    const output = getOutputSchema(lex);
    expect(output.required).toContain("indexed");
    expect(output.required).toContain("deleted");
    expect(output.properties.errors.type).toBe("array");
  });

  it("generates listRecords under <ns>.<short>.listRecords", () => {
    const params = getParams(lexicons["test.app.post.listRecords"]);
    expect(params.limit).toBeDefined();
    expect(params.cursor).toBeDefined();
    expect(params.actor).toBeDefined();
    expect(params.profiles).toBeDefined();
    expect(params.title).toBeDefined();
    expect(params.bodyParam ?? params.body).toBeDefined();
    expect(params.createdAtMin).toBeDefined();
    expect(params.createdAtMax).toBeDefined();
  });

  it("generates getRecord under <ns>.<short>.getRecord", () => {
    const lex = lexicons["test.app.post.getRecord"];
    expect(lex).toBeDefined();
    const params = getParams(lex);
    expect(params.uri).toBeDefined();
    expect(params.uri.required ?? lex.defs.main.parameters.required).toContain("uri");
  });

  it("does not emit the old NSID-based endpoint paths", () => {
    expect(lexicons["com.example.post.listRecords"]).toBeUndefined();
    expect(lexicons["com.example.post.getRecord"]).toBeUndefined();
  });
});

describe("relations and references", () => {
  let lexicons: Record<string, any>;

  beforeAll(() => {
    lexicons = generate(RELATIONS_CONFIG);
  });

  it("includes relation count params", () => {
    const params = getParams(lexicons["test.app.post.listRecords"]);
    expect(params.likesCountMin).toBeDefined();
    expect(params.hydrateLikes).toBeDefined();
  });

  it("includes reference hydrate params on child", () => {
    const params = getParams(lexicons["test.app.like.listRecords"]);
    expect(params.hydratePost).toBeDefined();
  });
});

describe("search: explicit fields", () => {
  let lexicons: Record<string, any>;
  beforeAll(() => {
    lexicons = generate(SEARCH_EXPLICIT_CONFIG);
  });

  it("exposes search param", () => {
    const params = getParams(lexicons["test.app.post.listRecords"]);
    expect(params.search).toBeDefined();
    expect(params.search.description).toContain("title");
    expect(params.search.description).toContain("body");
  });
});

describe("search: disabled", () => {
  it("does not include search param", () => {
    const lexicons = generate(SEARCH_DISABLED_CONFIG);
    const params = getParams(lexicons["test.app.post.listRecords"]);
    expect(params.search).toBeUndefined();
  });
});

describe("search: no searchable field configured", () => {
  it("does not include search param when searchable is omitted", () => {
    const lexicons = generate(SEARCH_AUTO_CONFIG);
    const params = getParams(lexicons["test.app.post.listRecords"]);
    expect(params.search).toBeUndefined();
  });
});

describe("extractXrpcMethods / listXrpcMethods", () => {
  it("extracts only queries and procedures from a generated lexicon map", () => {
    const lexicons = generate(BASIC_CONFIG);
    const methods = extractXrpcMethods(lexicons);
    // Sorted; includes admin + profile + listRecords/getRecord for the collection.
    expect(methods).toEqual([...methods].sort());
    expect(methods).toContain("test.app.post.listRecords");
    expect(methods).toContain("test.app.post.getRecord");
    expect(methods).toContain("test.app.getProfile");
    // Does not include non-method defs (e.g. `defs`, records, permission-set).
    expect(methods).not.toContain("test.app.authFull");
  });

  it("listXrpcMethods matches the authFull lxm list for the same config", () => {
    const methods = listXrpcMethods(BASIC_CONFIG, { rootDir: ROOT_DIR, lexiconDirs: [] });
    const lexicons = generate(BASIC_CONFIG);
    const ps = (lexicons["test.app.authFull"] as any).defs.main.permissions[0];
    expect(ps.lxm).toEqual(methods);
  });

  it("authFull auto-includes same-namespace collections in a repo permission", () => {
    const config: ContrailConfig = {
      namespace: "test.app",
      collections: {
        local: { collection: "test.app.thing" },
        external: { collection: "xyz.other.thing" },
      },
    };
    const lexicons = generate(config);
    const perms = (lexicons["test.app.authFull"] as any).defs.main.permissions;
    const repoEntry = perms.find((p: any) => p.resource === "repo");
    expect(repoEntry).toBeDefined();
    expect(repoEntry.collection).toEqual(["test.app.thing"]);
  });

  it("authFull omits the repo permission entry when no collections match the namespace", () => {
    const config: ContrailConfig = {
      namespace: "test.app",
      collections: {
        external: { collection: "xyz.other.thing" },
      },
    };
    const lexicons = generate(config);
    const perms = (lexicons["test.app.authFull"] as any).defs.main.permissions;
    expect(perms.find((p: any) => p.resource === "repo")).toBeUndefined();
  });

  it("includes realtime + community + spaces endpoints when those modules are enabled", () => {
    const config: ContrailConfig = {
      namespace: "test.comm",
      collections: { message: { collection: "app.event.message" } },
      spaces: { type: "tools.atmo.event.space", serviceDid: "did:web:test.example#svc" },
      community: { masterKey: new Uint8Array(32).fill(1) },
      realtime: { ticketSecret: new Uint8Array(32).fill(2) },
    };
    const methods = listXrpcMethods(config, { rootDir: ROOT_DIR, lexiconDirs: [] });
    expect(methods).toContain("test.comm.space.createSpace");
    expect(methods).toContain("test.comm.community.adopt");
    expect(methods).toContain("test.comm.realtime.ticket");
    expect(methods).toContain("test.comm.realtime.subscribe");
  });
});

describe("manifest emission (lexicons/generated/index.ts)", () => {
  let workdir: string;
  let outDir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "contrail-manifest-"));
    outDir = join(workdir, "lexicons", "generated");
  });
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("emits index.ts with imports for every generated lexicon", () => {
    generateLexicons({
      config: BASIC_CONFIG,
      rootDir: workdir,
      outputDir: outDir,
      lexiconDirs: [], // skip pulled/custom for this test
      quiet: true,
    });
    const manifest = readFileSync(join(outDir, "index.ts"), "utf-8");

    // One import per generated NSID — at minimum: collection-level + admin endpoints.
    expect(manifest).toMatch(/import _0 from "\.\/test\/app\/.*\.json";/);
    expect(manifest).toContain('export const lexicons: object[] =');

    // Sorted, so getCursor (admin) appears before post.* (collection).
    const importLines = manifest.split("\n").filter((l) => l.startsWith("import "));
    const paths = importLines.map((l) => l.match(/from "(.*?)"/)?.[1] ?? "");
    expect(paths).toEqual([...paths].sort());
  });

  it("includes pulled lexicons in the manifest (with relative paths)", () => {
    // Set up a fake pulled dir with one lexicon.
    const pulledDir = join(workdir, "lexicons", "pulled");
    mkdirSync(join(pulledDir, "app", "bsky", "actor"), { recursive: true });
    writeFileSync(
      join(pulledDir, "app", "bsky", "actor", "profile.json"),
      JSON.stringify({ lexicon: 1, id: "app.bsky.actor.profile", defs: {} })
    );

    rmSync(outDir, { recursive: true, force: true });
    generateLexicons({
      config: BASIC_CONFIG,
      rootDir: workdir,
      outputDir: outDir,
      lexiconDirs: [pulledDir],
      quiet: true,
    });
    const manifest = readFileSync(join(outDir, "index.ts"), "utf-8");

    // Pulled lexicon path is relative from outputDir, so it walks `..`.
    expect(manifest).toContain('import _0 from "../pulled/app/bsky/actor/profile.json";');
    // Generated lexicons are still there with `./` paths.
    expect(manifest).toMatch(/import _\d+ from "\.\/test\/app\//);
  });

  it("dedupes if the same path is somehow listed twice", () => {
    rmSync(outDir, { recursive: true, force: true });
    generateLexicons({
      config: BASIC_CONFIG,
      rootDir: workdir,
      outputDir: outDir,
      lexiconDirs: [],
      quiet: true,
    });
    const manifest = readFileSync(join(outDir, "index.ts"), "utf-8");
    const importLines = manifest.split("\n").filter((l) => l.startsWith("import "));
    const paths = importLines.map((l) => l.match(/from "(.*?)"/)?.[1] ?? "");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("does not emit a manifest when outputDir is omitted (in-memory only)", () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "contrail-no-output-"));
    try {
      generateLexicons({
        config: BASIC_CONFIG,
        rootDir: isolatedDir,
        // no outputDir
        lexiconDirs: [],
        quiet: true,
      });
      expect(existsSync(join(isolatedDir, "lexicons"))).toBe(false);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
