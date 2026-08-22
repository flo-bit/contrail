import { describe, expect, it } from "vitest";
import {
  formatSpaceRecordUri,
  formatSpaceUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  spaceProjectionKey,
} from "../src/uri";

describe("Space URIs", () => {
  const space = "at://did:plc:alice/space/garden.atmo.circle/self";

  it("round trips an exact Space and record URI", () => {
    expect(formatSpaceUri({
      authorityDid: "did:plc:alice",
      type: "garden.atmo.circle",
      skey: "self",
    })).toBe(space);
    expect(parseSpaceUri(space)).toMatchObject({
      authorityDid: "did:plc:alice",
      type: "garden.atmo.circle",
      skey: "self",
    });
    const record = formatSpaceRecordUri({
      spaceUri: space,
      writerDid: "did:plc:bob",
      collection: "garden.atmo.circle.note",
      rkey: "3mtest",
    });
    expect(parseSpaceRecordUri(record)).toMatchObject({
      spaceUri: space,
      writerDid: "did:plc:bob",
      collection: "garden.atmo.circle.note",
      rkey: "3mtest",
    });
  });

  it("keeps recreated Space generations distinct", () => {
    expect(spaceProjectionKey(space, 1)).not.toBe(spaceProjectionKey(space, 2));
  });

  it("rejects ordinary and overlong record paths", () => {
    expect(() => parseSpaceUri("at://did:plc:alice/garden.atmo.circle/self")).toThrow();
    expect(() => parseSpaceRecordUri(`${space}/did:plc:bob/garden.atmo.circle.note/a/extra`)).toThrow();
  });
});
