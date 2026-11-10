import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers";
import {
  initSchema,
  resolveConfig,
  resolveProfiles,
  type Database,
} from "../src/index";

const COLLECTION = "com.example.profile";
const OTHER_COLLECTION = "com.example.otherProfile";
const config = resolveConfig({
  namespace: "com.example",
  collections: {},
  profiles: [{ collection: COLLECTION, shortName: "profile" }],
});

async function seed(db: Database, count: number) {
  const dids = Array.from(
    { length: count },
    (_, i) => `did:plc:${String(i).padStart(24, "a")}`,
  );
  for (const [i, did] of dids.entries()) {
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(did, `person${i}.test`, "https://pds.example", Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO records_profile (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `at://${did}/${COLLECTION}/self`,
        did,
        "self",
        `cid${i}`,
        JSON.stringify({
          displayName: `Person ${i}`,
          labels: {
            $type: "com.atproto.label.defs#selfLabels",
            values: [{ val: "nudity" }],
          },
        }),
        1,
        1,
      )
      .run();
  }
  return dids;
}

function countReads(db: Database) {
  const prepare = db.prepare.bind(db);
  let maxBindings = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...values) => {
      maxBindings = Math.max(maxBindings, values.length);
      return bind(...values);
    };
    return stmt;
  });
  return { spy, maxBindings: () => maxBindings };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("indexed profile read cost", () => {
  it.each([1, 20, 41, 50, 51, 200, 201])(
    "hydrates %i indexed profiles with one read per 50 DIDs",
    async (count) => {
      const db = createTestDb();
      await initSchema(db, config);
      const dids = await seed(db, count);
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const { spy, maxBindings } = countReads(db);

      const profiles = await resolveProfiles(db, config, dids);

      expect(Object.keys(profiles)).toHaveLength(count);
      expect(profiles[dids[0]]).toMatchObject([
        {
          did: dids[0],
          uri: `at://${dids[0]}/${COLLECTION}/self`,
          handle: "person0.test",
          collection: COLLECTION,
          rkey: "self",
          cid: "cid0",
          value: { displayName: "Person 0" },
          selfLabels: [{ val: "nudity" }],
        },
      ]);
      expect(profiles[dids[count - 1]][0].handle).toBe(
        `person${count - 1}.test`,
      );
      expect(spy).toHaveBeenCalledTimes(Math.ceil(count / 50));
      expect(maxBindings()).toBeLessThanOrEqual(100);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("deduplicates input DIDs before batching and formatting", async () => {
    const db = createTestDb();
    await initSchema(db, config);
    const dids = await seed(db, 50);
    const { spy } = countReads(db);
    const profiles = await resolveProfiles(db, config, [...dids, ...dids]);
    expect(Object.keys(profiles)).toHaveLength(50);
    expect(profiles[dids[0]]).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps cached absence on the joined-read path and prefers a later indexed record", async () => {
    const db = createTestDb();
    await initSchema(db, config);
    const dids = await seed(db, 200);
    const uri = `at://${dids[0]}/${COLLECTION}/self`;
    await db
      .prepare("DELETE FROM records_profile WHERE uri = ?")
      .bind(uri)
      .run();
    await db
      .prepare("INSERT INTO _contrail_meta (key, value) VALUES (?, ?)")
      .bind(`profile-miss:${uri}`, String(Date.now() + 3_600_000))
      .run();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { spy } = countReads(db);

    expect((await resolveProfiles(db, config, dids))[dids[0]]).toEqual([
      { did: dids[0], handle: "person0.test" },
    ]);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(fetcher).not.toHaveBeenCalled();

    await db
      .prepare(
        "INSERT INTO records_profile (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        uri,
        dids[0],
        "self",
        "newcid",
        JSON.stringify({ displayName: "Now present" }),
        2,
        2,
      )
      .run();
    spy.mockClear();
    expect((await resolveProfiles(db, config, dids))[dids[0]]).toMatchObject([
      { value: { displayName: "Now present" } },
    ]);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports multiple profile collections and non-default rkeys without extra visibility reads", async () => {
    const multiple = resolveConfig({
      namespace: "com.example",
      collections: {},
      profiles: [
        { collection: COLLECTION, shortName: "profile" },
        {
          collection: OTHER_COLLECTION,
          shortName: "otherProfile",
          rkey: "about",
        },
      ],
    });
    const db = createTestDb();
    await initSchema(db, multiple);
    const [did] = await seed(db, 1);
    const uri = `at://${did}/${OTHER_COLLECTION}/about`;
    await db
      .prepare(
        "INSERT INTO records_otherProfile (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        uri,
        did,
        "about",
        "othercid",
        JSON.stringify({ displayName: "Other profile" }),
        1,
        1,
      )
      .run();
    const { spy } = countReads(db);
    const profiles = await resolveProfiles(db, multiple, [did]);
    expect(profiles[did]).toHaveLength(2);
    expect(profiles[did][1]).toMatchObject({
      uri,
      collection: OTHER_COLLECTION,
      rkey: "about",
      handle: "person0.test",
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not query for empty inputs or disabled profiles", async () => {
    const db = createTestDb();
    const { spy } = countReads(db);
    expect(await resolveProfiles(db, config, [])).toEqual({});
    expect(
      await resolveProfiles(db, { ...config, profiles: [] }, ["did:plc:test"]),
    ).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});
