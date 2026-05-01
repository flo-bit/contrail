import { describe, it, expect } from "vitest";
import { PROVISION_STATUSES } from "../src/core/community/types";

describe("PROVISION_STATUSES", () => {
  it("contains the six lifecycle statuses", () => {
    expect(PROVISION_STATUSES).toEqual([
      "keys_generated",
      "genesis_submitted",
      "account_created",
      "did_doc_updated",
      "activated",
      "orphaned",
    ]);
  });
});
