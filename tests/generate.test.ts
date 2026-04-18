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
