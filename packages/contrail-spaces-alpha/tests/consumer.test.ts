import { describe, expect, it } from "vitest";
import {
  addSimpleSpaceMember,
  createSpace,
  formatSpacePermissionScope,
  listSimpleSpaceMembers,
  removeSimpleSpaceMember,
  spacesConsumerOAuthScopes,
  updateSimpleSpacePolicy,
  type AuthenticatedPdsSession,
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

  it("uses the PDS-native member-list procedures", async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const session: AuthenticatedPdsSession = {
      did: "did:plc:alice",
      async handle(path, init) {
        calls.push({
          path,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (path.includes("listMembers")) {
          return Response.json({ members: [{ did: "did:plc:bob" }] });
        }
        return Response.json(path.includes("createSpace")
          ? { uri: "at://did:plc:alice/space/garden.atmo.circle/self" }
          : {});
      },
    };
    const space = "at://did:plc:alice/space/garden.atmo.circle/self";
    await createSpace(session, {
      type: "garden.atmo.circle",
      skey: "self",
      policy: { kind: "member-list" },
    });
    await addSimpleSpaceMember(session, space, "did:plc:bob");
    expect((await listSimpleSpaceMembers(session, { space })).members).toEqual([
      { did: "did:plc:bob" },
    ]);
    await removeSimpleSpaceMember(session, space, "did:plc:bob");
    await updateSimpleSpacePolicy(session, space, { kind: "member-list" });

    expect(calls[0].body?.policy).toEqual({
      $type: "com.atproto.simplespace.defs#memberListPolicy",
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/xrpc/com.atproto.simplespace.createSpace",
      "/xrpc/com.atproto.simplespace.addMember",
      `/xrpc/com.atproto.simplespace.listMembers?space=${encodeURIComponent(space)}`,
      "/xrpc/com.atproto.simplespace.removeMember",
      "/xrpc/com.atproto.simplespace.updateSpace",
    ]);
  });
});