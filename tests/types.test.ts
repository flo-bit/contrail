import { describe, it, expect } from "vitest";
import {
  validateFieldName,
  validateConfig,
  getNestedValue,
  getRelationField,
  resolveConfig,
  getCollectionNames,
  getDiscoverableCollections,
  getDependentCollections,
} from "../src/core/types";

describe("validateFieldName", () => {
  it("accepts simple field names", () => {
    expect(validateFieldName("name")).toBe("name");
    expect(validateFieldName("startsAt")).toBe("startsAt");
  });

  it("accepts dotted paths", () => {
    expect(validateFieldName("subject.uri")).toBe("subject.uri");
    expect(validateFieldName("a.b.c")).toBe("a.b.c");
  });

  it("accepts underscores and numbers", () => {
    expect(validateFieldName("field_1")).toBe("field_1");
    expect(validateFieldName("a2b")).toBe("a2b");
  });

  it("rejects special characters", () => {
    expect(() => validateFieldName("field; DROP TABLE")).toThrow("Invalid field name");
    expect(() => validateFieldName("field'")).toThrow("Invalid field name");
    expect(() => validateFieldName("a b")).toThrow("Invalid field name");
    expect(() => validateFieldName("$path")).toThrow("Invalid field name");
    expect(() => validateFieldName("")).toThrow("Invalid field name");
  });
});

describe("validateConfig", () => {
  it("passes for valid config", () => {
    expect(() =>
      validateConfig({
        collections: {
          "test.collection": {
            queryable: { name: {}, startsAt: { type: "range" } },
            relations: {
              items: { collection: "test.item", field: "subject.uri", groupBy: "status" },
            },
          },
        },
      })
    ).not.toThrow();
  });

  it("rejects invalid queryable field names", () => {
    expect(() =>
      validateConfig({
        collections: {
          "test.col": { queryable: { "bad field": {} } },
        },
      })
    ).toThrow("Invalid field name");
  });

  it("rejects invalid relation field", () => {
    expect(() =>
      validateConfig({
        collections: {
          "test.col": {
            relations: {
              r: { collection: "test.other", field: "bad field" },
            },
          },
        },
      })
    ).toThrow("Invalid field name");
  });

  it("rejects invalid groupBy", () => {
    expect(() =>
      validateConfig({
        collections: {
          "test.col": {
            relations: {
              r: { collection: "test.other", groupBy: "bad;field" },
            },
          },
        },
      })
    ).toThrow("Invalid field name");
  });
});

describe("getNestedValue", () => {
  it("gets top-level values", () => {
    expect(getNestedValue({ name: "hello" }, "name")).toBe("hello");
  });

  it("gets nested values", () => {
    expect(getNestedValue({ subject: { uri: "at://x" } }, "subject.uri")).toBe("at://x");
  });

  it("returns undefined for missing paths", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("handles null in path", () => {
    expect(getNestedValue({ a: null }, "a.b")).toBeUndefined();
    expect(getNestedValue(null, "a")).toBeUndefined();
  });
});

describe("getRelationField", () => {
  it("returns field when specified", () => {
    expect(getRelationField({ collection: "x", field: "subject.uri" })).toBe("subject.uri");
  });

  it("defaults to subject.uri", () => {
    expect(getRelationField({ collection: "x" })).toBe("subject.uri");
  });
});

describe("resolveConfig", () => {
  it("adds default profile collection", () => {
    const resolved = resolveConfig({ collections: { "test.col": {} } });
    expect(resolved.collections["app.bsky.actor.profile"]).toEqual({ discover: false });
  });

  it("does not overwrite existing profile collection config", () => {
    const resolved = resolveConfig({
      collections: { "app.bsky.actor.profile": { queryable: { displayName: {} } } },
    });
    expect(resolved.collections["app.bsky.actor.profile"].queryable).toEqual({ displayName: {} });
  });

  it("uses custom profiles", () => {
    const resolved = resolveConfig({
      collections: {},
      profiles: ["custom.profile"],
    });
    expect(resolved.profiles).toEqual([{ collection: "custom.profile" }]);
    expect(resolved.collections["custom.profile"]).toEqual({ discover: false });
    expect(resolved.collections["app.bsky.actor.profile"]).toBeUndefined();
  });

  it("applies default jetstreams and relays", () => {
    const resolved = resolveConfig({ collections: {} });
    expect(resolved.jetstreams).toHaveLength(4);
    expect(resolved.relays).toHaveLength(1);
  });
});

describe("getCollectionNames / getDiscoverableCollections / getDependentCollections", () => {
  const config = resolveConfig({
    collections: {
      "test.main": {},
      "test.dep": { discover: false },
    },
  });

  it("getCollectionNames returns all collections", () => {
    const names = getCollectionNames(config);
    expect(names).toContain("test.main");
    expect(names).toContain("test.dep");
    expect(names).toContain("app.bsky.actor.profile");
  });

  it("getDiscoverableCollections excludes discover:false", () => {
    const discoverable = getDiscoverableCollections(config);
    expect(discoverable).toContain("test.main");
    expect(discoverable).not.toContain("test.dep");
    expect(discoverable).not.toContain("app.bsky.actor.profile");
  });

  it("getDependentCollections returns discover:false", () => {
    const dependent = getDependentCollections(config);
    expect(dependent).toContain("test.dep");
    expect(dependent).toContain("app.bsky.actor.profile");
    expect(dependent).not.toContain("test.main");
  });
});
