import {
  initSchema,
  resolveConfig,
  resolveProfiles,
} from "../../dist/index.js";

const collection = "com.example.profile";
const config = resolveConfig({
  namespace: "com.example",
  collections: {},
  profiles: [{ collection, shortName: "profile" }],
});
const dids = Array.from(
  { length: 200 },
  (_, i) => `did:plc:${String(i).padStart(24, "a")}`,
);
const uri = (did) => `at://${did}/${collection}/self`;
let ready;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function seed(db) {
  await initSchema(db, config);
  for (let offset = 0; offset < dids.length; offset += 25) {
    await db.batch(
      dids
        .slice(offset, offset + 25)
        .flatMap((did, i) => [
          db
            .prepare(
              "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
            )
            .bind(
              did,
              `person${offset + i}.test`,
              "https://pds.example",
              Date.now(),
            ),
          db
            .prepare(
              "INSERT INTO records_profile (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              uri(did),
              did,
              "self",
              `cid${offset + i}`,
              JSON.stringify({ displayName: `Person ${offset + i}` }),
              1,
              1,
            ),
        ]),
    );
  }
}

function metered(db) {
  const stats = { queries: 0, maxBindings: 0, rowsRead: 0, sqlMs: 0 };
  function wrap(stmt) {
    return {
      bind(...values) {
        stats.maxBindings = Math.max(stats.maxBindings, values.length);
        return wrap(stmt.bind(...values));
      },
      async all() {
        stats.queries++;
        const result = await stmt.all();
        stats.rowsRead += result.meta.rows_read;
        stats.sqlMs +=
          result.meta.timings?.sql_duration_ms ?? result.meta.duration;
        return result;
      },
      async first() {
        stats.queries++;
        return stmt.first();
      },
      async run() {
        throw new Error("An indexed profile read must not write");
      },
    };
  }
  return {
    stats,
    db: {
      prepare(sql) {
        return wrap(db.prepare(sql));
      },
      async batch() {
        throw new Error("An indexed profile read must not write");
      },
    },
  };
}

async function read(db, count) {
  const meter = metered(db);
  const profiles = await resolveProfiles(
    meter.db,
    config,
    dids.slice(0, count),
  );
  assert(
    meter.stats.queries === Math.ceil(count / 50),
    `Unexpected query count: ${JSON.stringify(meter.stats)}`,
  );
  assert(meter.stats.maxBindings <= 100, "D1 binding budget exceeded");
  return { profiles, stats: meter.stats };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path !== "/run") return new Response("Not found", { status: 404 });
    ready ??= seed(env.DB);
    await ready;

    const small = await read(env.DB, 41);
    const large = await read(env.DB, 200);
    assert(
      Object.keys(large.profiles).length === 200,
      "Missing indexed profiles",
    );
    assert(
      large.profiles[dids[199]][0].handle === "person199.test",
      "Missing joined handle",
    );

    await env.DB.batch([
      env.DB.prepare("DELETE FROM records_profile WHERE uri = ?").bind(
        uri(dids[0]),
      ),
      env.DB.prepare(
        "INSERT INTO _contrail_meta (key, value) VALUES (?, ?)",
      ).bind(`profile-miss:${uri(dids[0])}`, String(Date.now() + 3_600_000)),
    ]);
    const negative = await read(env.DB, 200);
    assert(
      negative.profiles[dids[0]][0].uri === undefined,
      "Expected identity-only fallback",
    );

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO moderation_hidden (subject, kind, cid) VALUES (?, 'action', '')",
      ).bind(dids[1]),
      env.DB.prepare(
        "INSERT INTO moderation_hidden (subject, kind, cid) VALUES (?, 'action', ?)",
      ).bind(uri(dids[2]), "cid2"),
      env.DB.prepare(
        "INSERT INTO moderation_hidden (subject, kind, cid) VALUES (?, 'action', ?)",
      ).bind(uri(dids[3]), "other-cid"),
      env.DB.prepare(
        "INSERT INTO moderation_hidden (subject, kind, cid) VALUES (?, 'action', '')",
      ).bind(uri(dids[0])),
    ]);
    const moderated = await read(env.DB, 200);
    assert(
      !moderated.profiles[dids[0]],
      "Hidden absent profile resurrected a fallback",
    );
    assert(!moderated.profiles[dids[1]], "Account hide leaked");
    assert(!moderated.profiles[dids[2]], "Matching CID hide leaked");
    assert(
      moderated.profiles[dids[3]],
      "Non-matching CID hide suppressed a profile",
    );
    return Response.json({
      small: small.stats,
      large: large.stats,
      negative: negative.stats,
      moderated: moderated.stats,
    });
  },
};
