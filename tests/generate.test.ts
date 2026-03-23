import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { generateLexicons } from "../src/generate";
import type { ContrailConfig } from "../src/core/types";

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
    "com.example.post": {
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
    "com.example.post": {
      queryable: { title: {} },
      relations: {
        likes: {
          collection: "com.example.like",
        },
      },
    },
    "com.example.like": {
      queryable: { status: {} },
      references: {
        post: {
          collection: "com.example.post",
          field: "subject.uri",
        },
      },
    },
  },
};

const SEARCH_EXPLICIT_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    "com.example.post": {
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
    "com.example.post": {
      queryable: { title: {}, body: {} },
      searchable: false,
    },
  },
};

const SEARCH_AUTO_CONFIG: ContrailConfig = {
  namespace: "test.app",
  collections: {
    "com.example.post": {
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
    expect(lexicons["test.app.admin.getCursor"]).toBeDefined();
    expect(lexicons["test.app.admin.getOverview"]).toBeDefined();
    expect(lexicons["test.app.admin.sync"]).toBeDefined();
    expect(lexicons["test.app.admin.reset"]).toBeDefined();
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

  it("generates listRecords with standard params", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.limit).toBeDefined();
    expect(params.cursor).toBeDefined();
    expect(params.actor).toBeDefined();
    expect(params.profiles).toBeDefined();
  });

  it("generates queryable field params", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.title).toBeDefined();
    expect(params.title.type).toBe("string");
    expect(params.body).toBeDefined();
    expect(params.createdAtMin).toBeDefined();
    expect(params.createdAtMax).toBeDefined();
  });

  it("generates sort and order params", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.sort).toBeDefined();
    expect(params.sort.knownValues).toContain("title");
    expect(params.sort.knownValues).toContain("body");
    expect(params.sort.knownValues).toContain("createdAt");
    expect(params.order.knownValues).toEqual(["asc", "desc"]);
  });

  it("generates getRecord with uri param", () => {
    const params = getParams(lexicons["com.example.post.getRecord"]);
    expect(params.uri).toBeDefined();
    expect(params.uri.format).toBe("at-uri");
  });

  it("does not include search on getRecord", () => {
    const params = getParams(lexicons["com.example.post.getRecord"]);
    expect(params.search).toBeUndefined();
  });
});

describe("relations and references", () => {
  let lexicons: Record<string, any>;

  beforeAll(() => {
    lexicons = generate(RELATIONS_CONFIG);
  });

  it("generates count filter params for relations", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.likesCountMin).toBeDefined();
    expect(params.likesCountMin.type).toBe("integer");
  });

  it("generates hydrate params for relations", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.hydrateLikes).toBeDefined();
    expect(params.hydrateLikes.type).toBe("integer");
  });

  it("generates hydrate params for references", () => {
    const params = getParams(lexicons["com.example.like.listRecords"]);
    expect(params.hydratePost).toBeDefined();
    expect(params.hydratePost.type).toBe("boolean");
  });

  it("includes count fields in record def", () => {
    const recordDef = lexicons["com.example.post.listRecords"].defs.record;
    expect(recordDef.properties.likesCount).toBeDefined();
    expect(recordDef.properties.likesCount.type).toBe("integer");
  });

  it("includes relation shape in record def (ungrouped → array)", () => {
    const recordDef = lexicons["com.example.post.listRecords"].defs.record;
    expect(recordDef.properties.likes).toBeDefined();
    expect(recordDef.properties.likes.type).toBe("array");
  });

  it("includes reference shape in record def", () => {
    const recordDef = lexicons["com.example.like.listRecords"].defs.record;
    expect(recordDef.properties.post).toBeDefined();
    expect(recordDef.properties.post.type).toBe("ref");
  });

  it("sort knownValues includes count fields", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.sort.knownValues).toContain("likesCount");
  });
});

describe("search: explicit fields", () => {
  let lexicons: Record<string, any>;

  beforeAll(() => {
    lexicons = generate(SEARCH_EXPLICIT_CONFIG);
  });

  it("includes search param listing only explicit fields", () => {
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.search).toBeDefined();
    expect(params.search.description).toContain("title");
    expect(params.search.description).toContain("body");
    expect(params.search.description).not.toContain("category");
    expect(params.search.description).not.toContain("createdAt");
  });
});

describe("search: disabled", () => {
  it("does not include search param", () => {
    const lexicons = generate(SEARCH_DISABLED_CONFIG);
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.search).toBeUndefined();
  });
});

describe("search: no searchable field configured", () => {
  it("does not include search param when searchable is omitted", () => {
    const lexicons = generate(SEARCH_AUTO_CONFIG);
    const params = getParams(lexicons["com.example.post.listRecords"]);
    expect(params.search).toBeUndefined();
  });
});
