import { describe, it, expect } from "vitest";
import { jetstreamUrlOption } from "../src/core/types";

// @atcute/jetstream treats a string url and an array url differently *by design*:
// an array is a pool of interchangeable instances, so it seeds `#lastUsedUrl=''`
// and rolls the cursor back 10s on first connect to absorb clock skew between
// whichever instances a cursor crossed. A string is one fixed instance — no skew,
// no rollback. Contrail's cron model rebuilds the subscription every cycle, so for
// a single-instance config that "first-connect" rollback fires *every* cycle and
// redundantly re-ingests 10s. Collapsing a 1-instance pool to a string opts out of
// a safety margin we don't need; a real pool (2+) keeps it.
describe("jetstreamUrlOption", () => {
  it("collapses a single-instance pool to a string (no per-cycle skew rollback)", () => {
    expect(jetstreamUrlOption(["wss://one"])).toBe("wss://one");
  });

  it("keeps a real pool as an array (preserves cross-instance skew rollback)", () => {
    expect(jetstreamUrlOption(["wss://a", "wss://b"])).toEqual([
      "wss://a",
      "wss://b",
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(jetstreamUrlOption([])).toEqual([]);
  });
});
