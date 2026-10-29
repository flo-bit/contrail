import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema, resolveConfig, resolveProfiles } from "../src/index";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const HOUR = 3_600_000;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const db = createSqliteDatabase(":memory:");
  const config = resolveConfig({
    namespace: "rsvp.atmo",
    collections: {},
    profiles: [{ collection: "app.bsky.actor.profile", shortName: "profile" }],
  });
  await initSchema(db, config);
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
    )
    .bind(DID, "example.test", "https://pds.example", Date.now())
    .run();
  const fetcher = vi.fn(async () =>
    Response.json({ error: "RecordNotFound" }, { status: 400 }),
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    db,
    config,
    fetcher,
    read: () => resolveProfiles(db, config, [DID]),
  };
}

describe("profile miss cache survives the Contrail upgrade", () => {
  it("remembers authoritative absence across repeated reads and retries after a day", async () => {
    const { read, fetcher } = await setup();
    expect((await read())[DID]).toEqual([{ did: DID, handle: "example.test" }]);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 23 * HOUR);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retries transient failures within an hour instead of caching them for a day", async () => {
    const { read, fetcher } = await setup();
    fetcher.mockImplementation(async () => {
      throw new Error("Unavailable");
    });
    await read();
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + HOUR + 1);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("serves a live-ingested profile despite an outstanding miss", async () => {
    const { read, db, fetcher } = await setup();
    await read();
    await db
      .prepare(
        "INSERT INTO records_profile (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `at://${DID}/app.bsky.actor.profile/self`,
        DID,
        "self",
        "cid",
        JSON.stringify({ displayName: "Now present" }),
        1,
        1,
      )
      .run();
    expect((await read())[DID][0].value).toEqual({
      displayName: "Now present",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
