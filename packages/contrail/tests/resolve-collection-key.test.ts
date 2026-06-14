import { describe, it, expect } from "vitest";
import { resolveConfig, resolveCollectionKey } from "../src/core/types";

// resolveCollectionKey returns the key a collection's rows are stored under:
// its short alias when one exists, otherwise the NSID itself when the config is
// keyed directly by NSID. This is the resolution the records insert, FTS, and
// lookup paths all need (storage key), distinct from shortNameForNsid which
// only reports an alias and returns undefined for NSID-keyed configs.
describe("resolveCollectionKey", () => {
  it("returns the short alias for an alias-keyed collection", () => {
    const config = resolveConfig({
      namespace: "com.example",
      collections: {
        events: {
          collection: "community.lexicon.calendar.event",
          queryable: { name: {} },
        },
      },
    });
    expect(
      resolveCollectionKey(config, "community.lexicon.calendar.event"),
    ).toBe("events");
  });

  it("falls back to the NSID when the collection is keyed directly by its NSID", () => {
    const config = resolveConfig({
      namespace: "com.example",
      collections: {
        "community.lexicon.calendar.event": { queryable: { name: {} } },
      },
    });
    expect(
      resolveCollectionKey(config, "community.lexicon.calendar.event"),
    ).toBe("community.lexicon.calendar.event");
  });

  it("returns null for a collection the config does not know", () => {
    const config = resolveConfig({
      namespace: "com.example",
      collections: { "test.known": { queryable: { name: {} } } },
    });
    expect(resolveCollectionKey(config, "test.unknown")).toBeNull();
  });
});
