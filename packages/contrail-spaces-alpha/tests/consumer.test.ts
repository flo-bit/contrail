import { describe, expect, it } from "vitest";
import {
  putSpaceMember,
  createSpace,
  getSpace,
  formatSpacePermissionScope,
  listSpaceMembers,
  removeSpaceMember,
  spacesConsumerOAuthScopes,
  spacesIntegratedOAuthScopes,
  updateSpacePolicy,
  type AuthenticatedPdsSession,
  type SpacePolicy,
} from "../src/consumer";

const space = "at://did:plc:alice/space/garden.atmo.circle/self";

describe("consumer scopes", () => {
  it("requests Space writes and only exact provider methods", () => {
    const permission = formatSpacePermissionScope({
      type: "garden.atmo.circle",
      skey: "self",
      collections: ["garden.atmo.circle.note"],
    });
    expect(permission).toContain("space:garden.atmo.circle?");
    expect(permission).toContain("collection=garden.atmo.circle.note");
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
    const integrated = spacesIntegratedOAuthScopes({
      collections: ["garden.atmo.circle.note"],
      spaceType: "garden.atmo.circle",
      skey: "self",
    });
    expect(integrated).toHaveLength(2);
    expect(integrated.some((scope) => scope.startsWith("rpc?"))).toBe(false);
  });
});

describe("October 29 owner OAuth helpers", () => {
  it.each<SpacePolicy>([
    { $type: "com.atproto.personalspace.policy" },
    {
      $type: "com.atproto.memberspace.policy",
      publicRead: false,
      publicWrite: true,
      publishPolicy: true,
    },
    {
      $type: "com.atproto.managedspace.policy",
      managingApp: "did:web:app.example#spaces",
      publishPolicy: true,
    },
  ])(
    "sends a complete $type policy on create/update: $type",
    async (policy) => {
      const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
      const session: AuthenticatedPdsSession = {
        did: "did:plc:alice",
        async handle(path, init) {
          calls.push({
            path,
            body:
              typeof init?.body === "string"
                ? JSON.parse(init.body)
                : undefined,
          });
          if (path.includes("getSpace"))
            return Response.json({ uri: space, policy });
          if (path.includes("listMembers"))
            return Response.json({
              members: [{ did: "did:plc:bob", read: true, write: false }],
            });
          return Response.json(
            path.includes("createSpace") ? { uri: space } : {},
          );
        },
      };
      await createSpace(session, {
        spaceType: "garden.atmo.circle",
        skey: "self",
        policy,
      });
      expect(calls[0].body).toEqual({
        spaceType: "garden.atmo.circle",
        skey: "self",
        policy,
      });
      // A field change is an explicit read/merge/full replacement, not a patch.
      const current = await getSpace(session, space);
      await updateSpacePolicy(session, space, current.policy);
      expect(calls[2].body).toEqual({ space, policy });
      await putSpaceMember(session, space, "did:plc:bob", {
        read: true,
        write: false,
      });
      expect((await listSpaceMembers(session, { space })).members).toEqual([
        { did: "did:plc:bob", read: true, write: false },
      ]);
      await removeSpaceMember(session, space, "did:plc:bob");
      expect(calls.map((call) => call.path)).toEqual([
        "/xrpc/com.atproto.space.createSpace",
        `/xrpc/com.atproto.space.getSpace?space=${encodeURIComponent(space)}`,
        "/xrpc/com.atproto.space.updateSpace",
        "/xrpc/com.atproto.memberspace.putMember",
        `/xrpc/com.atproto.memberspace.listMembers?space=${encodeURIComponent(space)}`,
        "/xrpc/com.atproto.memberspace.removeMember",
      ]);
      // Write revocation/removal has server-owned writer-set side effects. No
      // duplicate removeWriter call or client-side member-list mutation.
      expect(calls[3].body).toEqual({
        space,
        did: "did:plc:bob",
        read: true,
        write: false,
      });
    },
  );
  it("preserves PolicyMismatch for callers without retrying or changing policy", async () => {
    let calls = 0;
    const session: AuthenticatedPdsSession = {
      did: "did:plc:alice",
      async handle() {
        calls++;
        return Response.json({ error: "PolicyMismatch" }, { status: 400 });
      },
    };
    await expect(
      putSpaceMember(session, space, "did:plc:bob", {
        read: true,
        write: true,
      }),
    ).rejects.toMatchObject({ code: "PolicyMismatch", status: 400 });
    expect(calls).toBe(1);
  });
});
