import { describe, it, expect } from "vitest";
import {
  validateFieldName,
  validateConfig,
  getNestedValue,
  getRelationField,
  resolveConfig,
  getCollectionShortNames,
  getDiscoverableShortNames,
  getDependentShortNames,
  getCollectionNsids,
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
        namespace: "test",
        collections: {
          col: {
            collection: "test.collection",
            queryable: { name: {}, startsAt: { type: "range" } },
            relations: {
              items: { collection: "item", field: "subject.uri", groupBy: "status" },
            },
          },
          item: {
            collection: "test.item",
          },
        },
      })
    ).not.toThrow();
  });

  it("rejects invalid queryable field names", () => {
    expect(() =>
      validateConfig({
        namespace: "test",
        collections: {
          col: { collection: "test.col", queryable: { "bad field": {} } },
        },
      })
    ).toThrow("Invalid field name");
  });

  it("rejects invalid relation field", () => {
    expect(() =>
      validateConfig({
        namespace: "test",
        collections: {
          col: {
            collection: "test.col",
            relations: {
              r: { collection: "other", field: "bad field" },
            },
          },
          other: { collection: "test.other" },
        },
      })
    ).toThrow("Invalid field name");
  });

  it("rejects invalid groupBy", () => {
    expect(() =>
      validateConfig({
        namespace: "test",
        collections: {
          col: {
            collection: "test.col",
            relations: {
              r: { collection: "other", groupBy: "bad;field" },
            },
          },
          other: { collection: "test.other" },
        },
      })
    ).toThrow("Invalid field name");
  });

  it("rejects relation to unknown collection short name", () => {
    expect(() =>
      validateConfig({
        namespace: "test",
        collections: {
          col: {
            collection: "test.col",
            relations: {
              r: { collection: "missing" },
            },
          },
        },
      })
    ).toThrow("references unknown collection");
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
  it("adds default profile collection (keyed by short name `profile`)", () => {
    const resolved = resolveConfig({
      namespace: "test",
      collections: { col: { collection: "test.col" } },
    });
    expect(resolved.collections["profile"]).toBeDefined();
    expect(resolved.collections["profile"].collection).toBe("app.bsky.actor.profile");
    expect(resolved.collections["profile"].discover).toBe(false);
  });

  it("does not overwrite existing profile entry", () => {
    const resolved = resolveConfig({
      namespace: "test",
      collections: {
        profile: { collection: "app.bsky.actor.profile", queryable: { displayName: {} } },
      },
    });
    expect(resolved.collections["profile"].queryable).toEqual({ displayName: {} });
  });

  it("uses custom profiles", () => {
    const resolved = resolveConfig({
      namespace: "test",
      collections: {},
      profiles: ["custom.profile"],
    });
    expect(resolved.profiles?.[0].collection).toBe("custom.profile");
    expect(resolved.collections["profile"]).toBeDefined();
    expect(resolved.collections["profile"].collection).toBe("custom.profile");
  });

  it("applies default jetstreams and relays", () => {
    const resolved = resolveConfig({ namespace: "test", collections: {} });
    expect(resolved.jetstreams).toHaveLength(4);
    expect(resolved.relays).toHaveLength(1);
  });

  it("builds nsidToShort reverse map", () => {
    const resolved = resolveConfig({
      namespace: "test",
      collections: {
        event: { collection: "test.event" },
        rsvp: { collection: "test.rsvp" },
      },
    });
    expect(resolved._resolved.nsidToShort["test.event"]).toBe("event");
    expect(resolved._resolved.nsidToShort["test.rsvp"]).toBe("rsvp");
  });
});

describe("collection lookup helpers", () => {
  const config = resolveConfig({
    namespace: "test",
    collections: {
      main: { collection: "test.main" },
      dep: { collection: "test.dep", discover: false },
    },
  });

  it("getCollectionShortNames returns all short names (including auto-added profile)", () => {
    const names = getCollectionShortNames(config);
    expect(names).toContain("main");
    expect(names).toContain("dep");
    expect(names).toContain("profile");
  });

  it("getCollectionNsids returns all record NSIDs", () => {
    const nsids = getCollectionNsids(config);
    expect(nsids).toContain("test.main");
    expect(nsids).toContain("test.dep");
    expect(nsids).toContain("app.bsky.actor.profile");
  });

  it("getDiscoverableShortNames excludes discover:false", () => {
    const discoverable = getDiscoverableShortNames(config);
    expect(discoverable).toContain("main");
    expect(discoverable).not.toContain("dep");
    expect(discoverable).not.toContain("profile");
  });

  it("getDependentShortNames returns discover:false", () => {
    const dependent = getDependentShortNames(config);
    expect(dependent).toContain("dep");
    expect(dependent).toContain("profile");
    expect(dependent).not.toContain("main");
  });
});
