import { describe, it, expect } from "vitest";
import { formatRecord, parseIntParam, fieldToParam } from "../src/core/router/helpers";
import type { RecordRow } from "../src/core/types";

describe("formatRecord", () => {
  it("parses JSON record string", () => {
    const row: RecordRow = {
      uri: "at://did:plc:test/test.col/abc",
      did: "did:plc:test",
      collection: "test.col",
      rkey: "abc",
      cid: "bafyabc",
      record: '{"name":"hello"}',
      time_us: 1000,
      indexed_at: 2000,
    };
    const formatted = formatRecord(row);
    expect(formatted.record).toEqual({ name: "hello" });
    expect(formatted.uri).toBe("at://did:plc:test/test.col/abc");
    expect(formatted.did).toBe("did:plc:test");
  });

  it("handles null record", () => {
    const row: RecordRow = {
      uri: "at://x/y/z",
      did: "did:plc:x",
      collection: "y",
      rkey: "z",
      cid: null,
      record: null,
      time_us: 0,
      indexed_at: 0,
    };
    expect(formatRecord(row).record).toBeNull();
  });

  it("returns raw string for invalid JSON", () => {
    const row: RecordRow = {
      uri: "at://x/y/z",
      did: "did:plc:x",
      collection: "y",
      rkey: "z",
      cid: null,
      record: "not-json",
      time_us: 0,
      indexed_at: 0,
    };
    expect(formatRecord(row).record).toBe("not-json");
  });
});

describe("parseIntParam", () => {
  it("parses valid integers", () => {
    expect(parseIntParam("42")).toBe(42);
    expect(parseIntParam("0")).toBe(0);
    expect(parseIntParam("-5")).toBe(-5);
  });

  it("returns default for null/undefined", () => {
    expect(parseIntParam(null, 10)).toBe(10);
    expect(parseIntParam(undefined, 10)).toBe(10);
    expect(parseIntParam(null)).toBeUndefined();
  });

  it("returns default for empty string", () => {
    expect(parseIntParam("", 50)).toBe(50);
  });

  it("returns default for non-numeric strings", () => {
    expect(parseIntParam("abc", 50)).toBe(50);
    expect(parseIntParam("abc")).toBeUndefined();
  });
});

describe("fieldToParam", () => {
  it("converts dotted paths to camelCase", () => {
    expect(fieldToParam("subject.uri")).toBe("subjectUri");
    expect(fieldToParam("a.b.c")).toBe("aBC");
  });

  it("leaves flat names unchanged", () => {
    expect(fieldToParam("name")).toBe("name");
    expect(fieldToParam("startsAt")).toBe("startsAt");
  });
});
