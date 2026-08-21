import type { AtprotoAudience } from "@atcute/lexicons/syntax";
import { describe, expect, it } from "vitest";
import { isPublicServiceManifest } from "../src/public-service";
import {
  compareCanonical,
  formatServiceOAuthScope,
  parseServiceAudience,
  parseServiceOAuthScope,
} from "../src/service-auth-contract";

const webAudience = "did:web:api.example.com#contrail" as AtprotoAudience;
const plcAudience =
  "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#contrail" as AtprotoAudience;

describe("parseServiceAudience", () => {
  it("separates supported web and PLC audiences from their base DIDs", () => {
    expect(parseServiceAudience(webAudience)).toEqual({
      audience: webAudience,
      serviceDid: "did:web:api.example.com",
      fragment: "contrail",
    });
    expect(parseServiceAudience(plcAudience)).toEqual({
      audience: plcAudience,
      serviceDid: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      fragment: "contrail",
    });
  });

  it.each([
    "did:web:api.example.com",
    "did:web:api.example.com#",
    "did:web:api.example.com#contrail#other",
    "did:web:api.example.com%23contrail",
    "did:key:zExample#contrail",
  ])("rejects an invalid service audience: %s", (audience) => {
    expect(() => parseServiceAudience(audience)).toThrow(/service audience/);
  });
});

describe("compareCanonical", () => {
  // The canonical order is baked into a scope string that a provider Worker
  // emits and a consumer compares byte for byte, so it must not depend on the
  // host locale or ICU build the way `localeCompare` does.
  it("orders by code unit, not by locale collation", () => {
    const mixedCase = ["com.example.get", "com.example.Get"];
    expect([...mixedCase].sort(compareCanonical)).toEqual([
      "com.example.Get",
      "com.example.get",
    ]);
    expect([...mixedCase].sort((left, right) => left.localeCompare(right))).toEqual([
      "com.example.get",
      "com.example.Get",
    ]);
  });

  it("sorts protected methods identically to a plain string sort", () => {
    const methods = [
      "com.example.notifyOfUpdate",
      "com.example.Get",
      "com.example.getFeed",
      "com.example.get",
    ];
    expect([...methods].sort(compareCanonical)).toEqual([...methods].sort());
  });

  it("keeps the emitted scope in code-unit order", () => {
    expect(
      formatServiceOAuthScope(webAudience, [
        "com.example.getFeed",
        "com.example.Get",
      ]),
    ).toBe(
      "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.Get&lxm=com.example.getFeed",
    );
  });
});

describe("formatServiceOAuthScope", () => {
  it("formats sorted, deduplicated exact method permissions", () => {
    expect(
      formatServiceOAuthScope(webAudience, [
        "com.example.notifyOfUpdate",
        "com.example.getFeed",
        "com.example.notifyOfUpdate",
      ]),
    ).toBe(
      "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed&lxm=com.example.notifyOfUpdate",
    );
  });

  it("rejects empty, wildcard, and malformed method lists", () => {
    expect(() => formatServiceOAuthScope(webAudience, [])).toThrow(
      "at least one method",
    );
    expect(() => formatServiceOAuthScope(webAudience, ["*"])).toThrow(
      "valid NSID",
    );
    expect(() => formatServiceOAuthScope(webAudience, ["not a method"])).toThrow(
      "valid NSID",
    );
  });
});

describe("public service-auth contract", () => {
  const manifest = () => ({
    format: "contrail.service",
    version: 2,
    endpoint: "https://api.example.com",
    namespace: "com.example",
    lexicons: {
      url: `https://api.example.com/lexicons/sha256:${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
    },
    status: { url: "https://api.example.com/status" },
    collections: [],
    methods: ["com.example.getCursor"],
    serviceAuth: {
      type: "atproto-service-auth",
      serviceDid: "did:web:api.example.com",
      audience: webAudience,
      scope:
        "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed",
      methods: [{ id: "com.example.getFeed", type: "query" }],
    },
  });

  it("accepts a coherent exact contract", () => {
    expect(isPublicServiceManifest(manifest())).toBe(true);
  });

  it("rejects incoherent or legacy service-auth fields", () => {
    const wrongDid = manifest();
    wrongDid.serviceAuth.serviceDid = "did:web:other.example.com";
    expect(isPublicServiceManifest(wrongDid)).toBe(false);

    const wrongScope = manifest();
    wrongScope.serviceAuth.scope =
      "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.other";
    expect(isPublicServiceManifest(wrongScope)).toBe(false);

    const duplicateMethod = manifest();
    duplicateMethod.serviceAuth.methods.push({
      id: "com.example.getFeed",
      type: "query",
    });
    expect(isPublicServiceManifest(duplicateMethod)).toBe(false);

    const legacy = manifest() as any;
    delete legacy.serviceAuth.serviceDid;
    delete legacy.serviceAuth.scope;
    legacy.serviceAuth.audience = "did:web:api.example.com";
    expect(isPublicServiceManifest(legacy)).toBe(false);
  });
});

describe("parseServiceOAuthScope", () => {
  it("accepts parameter reordering and returns a canonical exact scope", () => {
    expect(
      parseServiceOAuthScope(
        "rpc?lxm=com.example.notifyOfUpdate&aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed",
      ),
    ).toEqual({
      audience: webAudience,
      serviceDid: "did:web:api.example.com",
      fragment: "contrail",
      methods: ["com.example.getFeed", "com.example.notifyOfUpdate"],
      canonicalScope:
        "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed&lxm=com.example.notifyOfUpdate",
    });
  });

  it("deduplicates methods semantically", () => {
    const parsed = parseServiceOAuthScope(
      "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed&lxm=com.example.getFeed",
    );
    expect(parsed.methods).toEqual(["com.example.getFeed"]);
  });

  it("decodes the audience exactly once", () => {
    expect(
      parseServiceOAuthScope(
        "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed",
      ).audience,
    ).toBe(webAudience);
    expect(() =>
      parseServiceOAuthScope(
        "rpc?aud=did:web:api.example.com%2523contrail&lxm=com.example.getFeed",
      ),
    ).toThrow(/service audience/);
  });

  it("preserves plus characters used by the ecosystem formatter", () => {
    const audience =
      "did:web:api.example.com#contrail+test" as AtprotoAudience;
    const formatted = formatServiceOAuthScope(audience, [
      "com.example.getFeed",
    ]);
    expect(parseServiceOAuthScope(formatted).audience).toBe(audience);
  });

  it.each([
    "atproto",
    "rpc?",
    "rpc?aud=did:web:api.example.com%23contrail",
    "rpc?lxm=com.example.getFeed",
    "rpc?aud=did:web:api.example.com%23contrail&aud=did:web:other.example.com%23contrail&lxm=com.example.getFeed",
    "rpc?aud=did:web:api.example.com#contrail&lxm=com.example.getFeed",
    "rpc?aud=did:web:api.example.com%23contrail&lxm=*",
    "rpc?aud=did:web:api.example.com%23contrail&lxm=",
    "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed&extra=true",
    "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed%ZZ",
  ])("rejects an unsupported or malformed scope: %s", (scope) => {
    expect(() => parseServiceOAuthScope(scope)).toThrow();
  });
});
