import { describe, expect, it, vi } from "vitest";
import {
  createSpaceInvitations,
  invitationUrl,
  type SpaceInvitation,
} from "../src/invitations";
import type { AuthenticatedPdsSession } from "../src/consumer";

const owner = "did:plc:alice";
const space = `at://${owner}/space/events.example.private/dinner`;
const uri = `${space}/${owner}/community.lexicon.calendar.event/event`;
const policy = { $type: "com.atproto.personalspace.policy" };
function fixture() {
  const records = new Map<string, SpaceInvitation>();
  const membership = vi.fn();
  let controlPolicy: Record<string, unknown> = policy;
  let targetPolicyMismatch = false;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const session: AuthenticatedPdsSession = {
    did: owner,
    async handle(path, init) {
      const url = new URL(path, "https://pds.example");
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push({ path, body });
      if (path.includes("createSpace"))
        return Response.json({ error: "SpaceAlreadyExists" }, { status: 400 });
      if (path.includes("getSpace"))
        return Response.json({
          uri: url.searchParams.get("space"),
          policy: controlPolicy,
        });
      if (path.includes("putMember")) {
        if (targetPolicyMismatch)
          return Response.json({ error: "PolicyMismatch" }, { status: 400 });
        expect(url.pathname).toBe("/xrpc/com.atproto.memberspace.putMember");
        membership(body);
        return Response.json({});
      }
      if (path.includes("putRecord")) {
        records.set(body.rkey, body.record);
        return Response.json({});
      }
      if (path.includes("deleteRecord")) {
        records.delete(body.rkey);
        return Response.json({});
      }
      const value = records.get(url.searchParams.get("rkey")!);
      return value
        ? Response.json({ value, cid: "cid" })
        : Response.json({ error: "RecordNotFound" }, { status: 404 });
    },
  };
  const preview = vi.fn(async () => ({ name: "Dinner" }));
  const restore = vi.fn(async () => session);
  const invitations = createSpaceInvitations({
    controlSpaceType: "events.example.invites",
    invitationCollection: "events.example.invitation",
    targets: { "events.example.private": ["community.lexicon.calendar.event"] },
    restoreOwnerSession: restore,
    preview,
    now: () => 1000,
  });
  const guest = {
    did: "did:plc:bob",
    handle: vi.fn(),
  } as AuthenticatedPdsSession;
  return {
    invitations,
    session,
    guest,
    records,
    membership,
    preview,
    restore,
    calls,
    setControlPolicy: (value: Record<string, unknown>) => {
      controlPolicy = value;
    },
    changeTargetPolicy: () => {
      targetPolicyMismatch = true;
    },
  };
}

describe("PDS-owned reusable invitation links", () => {
  it("stores only the verifier in an owner-only Space, and previews without joining", async () => {
    const f = fixture();
    const link = await f.invitations.create(f.session, { space, uri });
    expect(link.secret).toHaveLength(43);
    const url = new URL(invitationUrl("https://events.example", link));
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${link.secret}`);
    expect(JSON.stringify([...f.records.values()])).not.toContain(link.secret);
    expect(await f.invitations.preview(link)).toEqual({ name: "Dinner" });
    expect(f.preview).toHaveBeenCalledWith(
      { space, uri, collection: "community.lexicon.calendar.event" },
      f.session,
    );
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.guest.handle).not.toHaveBeenCalled();
    expect(f.calls[0]).toEqual({
      path: "/xrpc/com.atproto.space.createSpace",
      body: {
        spaceType: "events.example.invites",
        skey: "self",
        policy: { $type: "com.atproto.personalspace.policy" },
      },
    });
    expect(
      f.calls.some(({ path }) =>
        path.startsWith("/xrpc/com.atproto.memberspace.listMembers"),
      ),
    ).toBe(false);
  });
  it("restores the offline host and adds the authenticated DID idempotently", async () => {
    const f = fixture();
    const link = await f.invitations.create(f.session, { space, uri });
    await f.invitations.accept(f.guest, link);
    await f.invitations.accept(f.guest, link);
    expect(f.restore).toHaveBeenCalledWith(owner);
    expect(f.membership).toHaveBeenLastCalledWith({
      space,
      did: f.guest.did,
      read: true,
      write: true,
    });
    expect(f.guest.handle).not.toHaveBeenCalled();
  });
  it("rejects a bad secret, expiry, wrong recipient and target tampering before membership", async () => {
    const f = fixture();
    const link = await f.invitations.create(f.session, {
      space,
      uri,
      recipient: "did:plc:carol",
    });
    await expect(f.invitations.accept(f.guest, link)).rejects.toMatchObject({
      code: "WrongRecipient",
    });
    await expect(
      f.invitations.preview({ ...link, secret: "x".repeat(43) }),
    ).rejects.toMatchObject({ code: "InvalidInvitation" });
    const record = f.records.get(link.rkey)!;
    record.expiresAt = new Date(999).toISOString();
    await expect(f.invitations.preview(link)).rejects.toMatchObject({
      code: "InvalidInvitation",
    });
    delete record.expiresAt;
    record.space = space.replace("alice", "mallory");
    await expect(f.invitations.preview(link)).rejects.toMatchObject({
      code: "InvalidInvitation",
    });
    expect(f.membership).not.toHaveBeenCalled();
  });
  it.each([
    { $type: "com.atproto.memberspace.policy" },
    { $type: "com.atproto.memberspace.policy", publicRead: true },
    { $type: "com.atproto.memberspace.policy", publicWrite: true },
    {
      $type: "com.atproto.managedspace.policy",
      managingApp: "did:web:app.example",
    },
    { $type: "unknown.policy" },
  ])("rejects unsafe control policies: %j", async (unsafe) => {
    const f = fixture();
    const link = await f.invitations.create(f.session, { space, uri });
    f.setControlPolicy(unsafe);
    await expect(f.invitations.accept(f.guest, link)).rejects.toMatchObject({
      code: "InvalidInvitation",
    });
    await expect(f.invitations.preview(link)).rejects.toMatchObject({
      code: "InvalidInvitation",
    });
    expect(f.membership).not.toHaveBeenCalled();
  });
  it("does not convert a target that no longer supports membership", async () => {
    const f = fixture();
    const link = await f.invitations.create(f.session, { space, uri });
    f.changeTargetPolicy();
    await expect(f.invitations.accept(f.guest, link)).rejects.toMatchObject({
      code: "InvalidInvitation",
    });
    expect(f.calls.some(({ path }) => path.includes("updateSpace"))).toBe(
      false,
    );
    expect(f.membership).not.toHaveBeenCalled();
  });
  it("revokes a link without removing existing members", async () => {
    const f = fixture();
    const link = await f.invitations.create(f.session, { space, uri });
    await f.invitations.accept(f.guest, link);
    await f.invitations.revoke(f.session, link.rkey);
    await expect(f.invitations.preview(link)).rejects.toThrow();
    expect(f.membership).toHaveBeenCalledTimes(1);
  });
  it("supports adding a resolved handle's DID without a link", async () => {
    const f = fixture();
    await f.invitations.addMember(f.session, { space, did: f.guest.did });
    expect(f.membership).toHaveBeenCalledWith({
      space,
      did: f.guest.did,
      read: true,
      write: true,
    });
    await expect(
      f.invitations.addMember(f.session, {
        space: space.replace("alice", "mallory"),
        did: f.guest.did,
      }),
    ).rejects.toThrow();
  });
  it("does not use a restored session belonging to a different owner", async () => {
    const f = fixture();
    const link = await f.invitations.create(f.session, { space, uri });
    f.restore.mockResolvedValue(f.guest);
    await expect(f.invitations.accept(f.guest, link)).rejects.toMatchObject({
      code: "OwnerUnavailable",
    });
    expect(f.membership).not.toHaveBeenCalled();
  });
});
