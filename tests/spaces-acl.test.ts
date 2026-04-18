import { describe, it, expect } from "vitest";
import { checkAccess } from "../src/core/spaces/acl";
import type { SpaceMemberRow, SpaceRow } from "../src/core/spaces/types";

function mkSpace(overrides: Partial<SpaceRow> = {}): SpaceRow {
  return {
    uri: "at://did:plc:alice/tools.atmo.event.space/s1",
    ownerDid: "did:plc:alice",
    type: "tools.atmo.event.space",
    key: "s1",
    serviceDid: "did:web:example.com#svc",
    memberListRef: null,
    appPolicyRef: null,
    appPolicy: null,
    createdAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function mkMember(did: string, perms: "read" | "write" = "write"): SpaceMemberRow {
  return { spaceUri: "x", did, perms, addedAt: 1, addedBy: null };
}

describe("spaces acl", () => {
  it("owner can read/write/delete without a member row", () => {
    const s = mkSpace();
    for (const op of ["read", "write", "delete"] as const) {
      const r = checkAccess({
        op,
        space: s,
        callerDid: "did:plc:alice",
        member: null,
      });
      expect(r.allow).toBe(true);
    }
  });

  it("non-member cannot read", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "read",
      space: s,
      callerDid: "did:plc:bob",
      member: null,
    });
    expect(r.allow).toBe(false);
    expect((r as any).reason).toBe("not-member");
  });

  it("member with read perm can read", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "read",
      space: s,
      callerDid: "did:plc:bob",
      member: mkMember("did:plc:bob", "read"),
    });
    expect(r.allow).toBe(true);
  });

  it("member with read perm cannot write", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "write",
      space: s,
      callerDid: "did:plc:bob",
      member: mkMember("did:plc:bob", "read"),
    });
    expect(r.allow).toBe(false);
    expect((r as any).reason).toBe("not-writer");
  });

  it("member with write perm can write", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "write",
      space: s,
      callerDid: "did:plc:bob",
      member: mkMember("did:plc:bob", "write"),
    });
    expect(r.allow).toBe(true);
  });

  it("non-member cannot write", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "write",
      space: s,
      callerDid: "did:plc:bob",
      member: null,
    });
    expect(r.allow).toBe(false);
    expect((r as any).reason).toBe("not-writer");
  });

  it("delete own: member-with-write can delete own record", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "delete",
      space: s,
      callerDid: "did:plc:bob",
      member: mkMember("did:plc:bob", "write"),
      targetAuthorDid: "did:plc:bob",
    });
    expect(r.allow).toBe(true);
  });

  it("delete other's: member-with-write cannot delete someone else's record", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "delete",
      space: s,
      callerDid: "did:plc:bob",
      member: mkMember("did:plc:bob", "write"),
      targetAuthorDid: "did:plc:charlie",
    });
    expect(r.allow).toBe(false);
    expect((r as any).reason).toBe("not-own-record");
  });

  it("delete any: owner can delete anyone's record", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "delete",
      space: s,
      callerDid: "did:plc:alice",
      member: null,
      targetAuthorDid: "did:plc:bob",
    });
    expect(r.allow).toBe(true);
  });

  it("delete without write perm: read-only member cannot delete own", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "delete",
      space: s,
      callerDid: "did:plc:bob",
      member: mkMember("did:plc:bob", "read"),
      targetAuthorDid: "did:plc:bob",
    });
    expect(r.allow).toBe(false);
    expect((r as any).reason).toBe("not-writer");
  });

  it("app policy: allow-mode with apps[] denylists those apps", () => {
    const s = mkSpace({ appPolicy: { mode: "allow", apps: ["blocked.app"] } });
    const ok = checkAccess({
      op: "read",
      space: s,
      callerDid: "did:plc:alice",
      member: null,
      clientId: "fine.app",
    });
    expect(ok.allow).toBe(true);

    const blocked = checkAccess({
      op: "read",
      space: s,
      callerDid: "did:plc:alice",
      member: null,
      clientId: "blocked.app",
    });
    expect(blocked.allow).toBe(false);
    expect((blocked as any).reason).toBe("app-not-allowed");
  });

  it("app policy: deny-mode with apps[] allowlists those apps", () => {
    const s = mkSpace({ appPolicy: { mode: "deny", apps: ["trusted.app"] } });
    const ok = checkAccess({
      op: "read",
      space: s,
      callerDid: "did:plc:alice",
      member: null,
      clientId: "trusted.app",
    });
    expect(ok.allow).toBe(true);

    const blocked = checkAccess({
      op: "read",
      space: s,
      callerDid: "did:plc:alice",
      member: null,
      clientId: "anon.app",
    });
    expect(blocked.allow).toBe(false);
    expect((blocked as any).reason).toBe("app-not-allowed");
  });
});
