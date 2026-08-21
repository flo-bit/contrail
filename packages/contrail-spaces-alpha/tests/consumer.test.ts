import { describe, expect, it } from "vitest";
import {
  formatSpacePermissionScope,
  spacesConsumerOAuthScopes,
} from "../src/consumer";

describe("consumer scopes", () => {
  it("requests Space writes and only exact provider methods", () => {
    const space = formatSpacePermissionScope({
      type: "garden.atmo.circle",
      skey: "self",
      collections: ["garden.atmo.circle.note"],
    });
    expect(space).toContain("space:garden.atmo.circle?");
    expect(space).toContain("collection=garden.atmo.circle.note");
    const scopes = spacesConsumerOAuthScopes({
      audience: "did:web:spaces.atmo.garden#spaces",
      namespace: "garden.atmo.circle",
      collections: ["garden.atmo.circle.note"],
      spaceType: "garden.atmo.circle",
      skey: "self",
    });
    expect(scopes[2]).toContain("aud=did:web:spaces.atmo.garden%23spaces");
    expect(scopes[2]).toContain("garden.atmo.circle.note.listSpaceRecords");
    expect(scopes[2]).toContain("garden.atmo.circle.listSpaces");
    expect(scopes[2]).toContain("garden.atmo.circle.subscribeSpace");
    expect(scopes[2]).not.toContain("notifyWrite");
  });
});
