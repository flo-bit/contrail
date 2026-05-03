import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { createTestDbWithSchema } from "./helpers";

describe("community_sessions cache", () => {
  let adapter: CommunityAdapter;

  beforeEach(async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    adapter = new CommunityAdapter(db);
  });

  it("upserts and reads a cached session", async () => {
    await adapter.upsertSession("did:plc:x", {
      accessJwt: "atok",
      refreshJwt: "rtok",
      accessExp: 1234,
    });
    const got = await adapter.getSession("did:plc:x");
    expect(got).toEqual({ accessJwt: "atok", refreshJwt: "rtok", accessExp: 1234 });
  });

  it("returns null for missing did", async () => {
    const got = await adapter.getSession("did:plc:nope");
    expect(got).toBeNull();
  });

  it("clears a session", async () => {
    await adapter.upsertSession("did:plc:x", {
      accessJwt: "a",
      refreshJwt: "r",
      accessExp: 1,
    });
    await adapter.clearSession("did:plc:x");
    expect(await adapter.getSession("did:plc:x")).toBeNull();
  });

  it("upsert overwrites existing session for the same did", async () => {
    await adapter.upsertSession("did:plc:x", {
      accessJwt: "old-a",
      refreshJwt: "old-r",
      accessExp: 100,
    });
    await adapter.upsertSession("did:plc:x", {
      accessJwt: "new-a",
      refreshJwt: "new-r",
      accessExp: 200,
    });
    const got = await adapter.getSession("did:plc:x");
    expect(got).toEqual({ accessJwt: "new-a", refreshJwt: "new-r", accessExp: 200 });
  });

  it("isolates sessions across communities", async () => {
    await adapter.upsertSession("did:plc:a", {
      accessJwt: "a-tok",
      refreshJwt: "a-rtok",
      accessExp: 1,
    });
    await adapter.upsertSession("did:plc:b", {
      accessJwt: "b-tok",
      refreshJwt: "b-rtok",
      accessExp: 2,
    });
    expect(await adapter.getSession("did:plc:a")).toEqual({
      accessJwt: "a-tok",
      refreshJwt: "a-rtok",
      accessExp: 1,
    });
    expect(await adapter.getSession("did:plc:b")).toEqual({
      accessJwt: "b-tok",
      refreshJwt: "b-rtok",
      accessExp: 2,
    });
    await adapter.clearSession("did:plc:a");
    expect(await adapter.getSession("did:plc:a")).toBeNull();
    // Clearing one DID must not affect the other.
    expect(await adapter.getSession("did:plc:b")).toEqual({
      accessJwt: "b-tok",
      refreshJwt: "b-rtok",
      accessExp: 2,
    });
  });
});
