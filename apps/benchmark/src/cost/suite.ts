import type { ContrailConfig, Database, IngestEvent } from "@atmo-dev/contrail";
import {
  ingestRecords, initSchema, queryRecords, resolveConfig, MODERATION_ACTION_NSID, visibleRecordSql,
} from "../../../../packages/contrail/src/index";
import { saveCursorStatement, getLastCursor, sweepFeedItems } from "../../../../packages/contrail/src/core/db/records";
import { buildFeedTargetCaps } from "../../../../packages/contrail/src/core/types";
import { applyLabels, type IncomingLabel } from "../../../../packages/contrail/src/core/labels/apply";
import { accountUpdateStatements, initModerationReports } from "../../../../packages/contrail/src/core/moderation";
import { runModerationCycle, runModerationRecounts } from "../../../../packages/contrail/src/core/moderation-sync";
import { runPipeline } from "../../../../packages/contrail/src/core/router/collection";
import { createCostMeter } from "./meter";
import { calibrateAccounting } from "./calibrate";
import { runReportWorkloads } from "./reports";
import { actor, BATCH_SIZE, FIXED_NOW, LABELER, MODERATOR, NSIDS, makeFixture, type FixtureOptions } from "./fixture";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Cost workload correctness failed: ${message}`);
}

/** One fixture per fresh local D1 database. No external services or production bindings. */
export async function runCostSuite(raw: Database, options: FixtureOptions) {
  const fixture = makeFixture(options);
  const { config, posts, event, full, moderated } = fixture;
  const meter = createCostMeter(raw);
  const { db } = meter;
  const knownDids = new Set(Array.from({ length: options.actors }, (_, i) => actor(i)));
  const measure = meter.measure;
  let assertions = 0;
  let now = FIXED_NOW;
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  Date.now = () => now;
  globalThis.fetch = (async () => {
    networkAttempts++;
    throw new Error("Cost fixtures must not access the network");
  }) as typeof fetch;

  async function ingest(events: IngestEvent[], activeConfig: ContrailConfig = config, allowDrops = false) {
    let accepted = 0;
    const drops: Record<string, number> = {};
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const chunk = events.slice(i, i + BATCH_SIZE);
      const cursor = Number(chunk.at(-1)!.source!.cursor);
      const result = await ingestRecords(db, chunk, activeConfig, {
        knownDids, trailingStatements: [saveCursorStatement(db, cursor)],
      });
      accepted += result.accepted.length;
      for (const [key, count] of Object.entries(result.dropped)) drops[key] = (drops[key] ?? 0) + count;
    }
    meter.note("attempted", events.length);
    meter.note("acceptedMutations", accepted);
    for (const [key, count] of Object.entries(drops)) if (count) meter.note(`dropped.${key}`, count);
    if (!allowDrops) check(accepted === events.length && Object.values(drops).every((n) => n === 0), "unexpected ingestion drops");
    return { accepted, drops };
  }

  async function drainRecounts(activeConfig: ContrailConfig = config) {
    let pages = 0;
    for (let cycle = 0; cycle < 100; cycle++) {
      const n = await runModerationRecounts(db, activeConfig, Date.now() + 60_000, 50);
      pages += n;
      if (!n) { meter.note("recountPages", pages); return; }
    }
    throw new Error("Moderation recounts did not drain within the fixture bound");
  }

  async function countsCorrect() {
    for (const post of [posts[0]!, posts[1]!]) {
      const row = await db.prepare(`SELECT count_reaction AS total, count_reaction_like AS likes,
        count_comment AS comments FROM records_post WHERE uri = ?`).bind(post.uri)
        .first<{ total: number; likes: number; comments: number }>();
      const reactions = await db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN json_extract(r.record, '$.kind') = 'like' THEN 1 ELSE 0 END), 0) AS likes
        FROM records_reaction r WHERE json_extract(r.record, '$.subject.uri') = ? AND ${visibleRecordSql("r")}`)
        .bind(post.uri).first<{ total: number; likes: number }>();
      const comments = await db.prepare(`SELECT COUNT(*) AS n FROM records_comment r
        WHERE json_extract(r.record, '$.subject.uri') = ? AND ${visibleRecordSql("r")}`)
        .bind(post.uri).first<{ n: number }>();
      check(row && reactions && comments && row.total === reactions.total && row.likes === reactions.likes && row.comments === comments.n,
        `visible relation counts for ${post.uri}`);
      assertions++;
    }
  }
  async function visible(uri: string, expected: boolean, collection: "post" | "reaction" = "post") {
    const result = await db.prepare(`SELECT 1 FROM records_${collection} r WHERE uri = ? AND ${visibleRecordSql("r")}`).bind(uri).first();
    check(Boolean(result) === expected, `visibility ${uri}: expected ${expected}`);
    assertions++;
  }
  async function verify(name: string, fn: () => Promise<void> = countsCorrect) {
    await measure(`verify.${name}`, "verification", 1, "check-set", fn);
  }
  async function storage() {
    const result: Record<string, number> = {};
    for (const table of ["records_post", "records_reaction", "records_comment", "record_versions", "labels", "moderation_hidden", "identities", ...(full ? ["feed_items"] : []), ...(moderated ? ["moderation_reports", "moderation_report_limits"] : [])]) {
      result[table] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    }
    return result;
  }
  async function labels(labels: IncomingLabel[], activeConfig = config) {
    for (let i = 0; i < labels.length; i += BATCH_SIZE) {
      const chunk = labels.slice(i, i + BATCH_SIZE);
      const applied = await applyLabels(db, chunk, { source: activeConfig.labels!.sources[0], config: activeConfig });
      check(applied === chunk.length, "labels admitted");
    }
    await drainRecounts(activeConfig);
  }
  const label = (uri: string, extra: Partial<IncomingLabel> = {}): IncomingLabel => ({
    src: LABELER, uri, val: "!hide", cts: new Date(now - 10_000).toISOString(), ...extra,
  });

  try {
    const accountingSanity = await measure("verify.accounting", "verification", 1, "probe", () => calibrateAccounting(db));
    assertions++;
    await measure("setup.schema", "setup", 1, "initialization", () => initSchema(db, config));
    if (moderated) await measure("setup.report-schema", "setup", 1, "initialization", () => initModerationReports(db));
    await measure("setup.actors", "setup", options.actors, "actor", async () => {
      // Complete, fresh identity cache: enrichment requests are intentionally not part of this SQL fixture.
      for (let i = 0; i < options.actors; i += BATCH_SIZE) {
        await db.batch(Array.from({ length: Math.min(BATCH_SIZE, options.actors - i) }, (_, j) =>
          db.prepare("INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)")
            .bind(actor(i + j), `cost${i + j}.example`, "https://pds.invalid", FIXED_NOW)));
      }
      if (full) {
        const profiles = Array.from(knownDids, (did, i) => event(NSIDS.profile, did, "self", { $type: NSIDS.profile, displayName: `Person ${i}` }));
        await ingest(profiles);
      }
    });
    if (full) await measure("setup.follows", "setup", options.actors * 2 - 2, "follow", async () => {
      const follows: IngestEvent[] = [];
      for (let i = 1; i < options.actors; i++) {
        follows.push(event(NSIDS.follow, actor(i), "hot", { subject: actor(0) }));
        follows.push(event(NSIDS.follow, actor(i - 1), "next", { subject: actor(i) }));
      }
      await ingest(follows);
    });
    await measure("setup.records", "setup", posts.length + fixture.comments.length + fixture.reactions.length + fixture.hotReactions.length, "record", async () => {
      for (const records of [posts, fixture.comments, fixture.reactions, fixture.hotReactions]) await ingest(records);
    });
    if (moderated) await measure("setup.labels", "setup", posts.length, "label", () =>
      labels(posts.map((post) => label(post.uri, { val: "warn" }))));
    await verify("seed");
    const seededStorage = await measure("verify.storage-seeded", "verification", 1, "snapshot", storage);

    const created = Array.from({ length: options.operations }, (_, i) => event(NSIDS.post, actor(i % options.actors), `new${i}`, fixture.value(options.posts + i)));
    await measure("ingest.create", "workload", created.length, "record", () => ingest(created));
    const updates = Array.from({ length: options.operations }, (_, i) => {
      // Fixed cold targets: corpus growth adds unrelated records, not more children to these parents.
      const post = posts[1 + i % 8]!;
      return event(NSIDS.post, post.did, post.rkey, { ...JSON.parse(post.record!), text: `Updated sample content ${i}` }, "update");
    });
    // A batch may contain multiple versions of a target: only its winner is accepted.
    await measure("ingest.update", "workload", updates.length, "observation", () => ingest(updates, config, true));
    const latest = [...new Map(updates.map((update) => [update.uri, update])).values()];
    const unchanged = latest.map((post) => event(post.collection, post.did, post.rkey, JSON.parse(post.record!), "update", post.cid));
    await measure("ingest.unchanged", "workload", unchanged.length, "observation", () => ingest(unchanged));
    await measure("ingest.exact-replay", "workload", unchanged.length, "observation", async () => {
      const result = await ingest(unchanged, config, true);
      check(result.accepted === 0 && result.drops.superseded === unchanged.length, "exact replay rejected");
    });
    const stale = posts.slice(1, 9);
    await measure("ingest.stale-replay", "workload", stale.length, "observation", async () => {
      const result = await ingest(stale, config, true);
      check(result.accepted === 0 && result.drops.superseded === stale.length, "stale replay rejected");
    });
    const deleted = created.map((post) => event(post.collection, post.did, post.rkey, null, "delete"));
    await measure("ingest.delete", "workload", deleted.length, "record", () => ingest(deleted));
    await verify("deletes", async () => {
      for (const post of created) await visible(post.uri, false);
      await countsCorrect();
    });
    const hot = Array.from({ length: options.operations }, (_, i) => event(NSIDS.reaction, actor(i % options.actors), `newhot${i}`, {
      subject: { uri: posts[0]!.uri }, kind: i % 2 ? "like" : "love",
    }));
    await measure("ingest.hot-reactions", "workload", hot.length, "reaction", () => ingest(hot));
    await verify("hot-counts");

    const queryCases = {
      list: { limit: 20 },
      filter: { limit: 20, filters: { category: "photos" } },
      search: { limit: 20, search: "sample" },
      "count-sort": { limit: 20, sort: { countType: "reaction", direction: "desc" as const } },
    };
    for (const [name, query] of Object.entries(queryCases)) await measure(`query.${name}`, "workload", options.operations, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const result = await queryRecords(db, config, { collection: "post", ...query });
        check(result.records.length > 0 && result.records.length <= 20, `${name} returns a bounded page`);
        if (name === "filter") check(result.records.every((record) => JSON.parse(record.record!).category === "photos"), "indexed filter results");
        if (name === "search") check(result.records.every((record) => JSON.parse(record.record!).text.includes("sample")), "search results");
        if (name === "count-sort") check(result.records.every((record, index, rows) => index === 0 || (rows[index - 1]!.counts?.reaction ?? 0) >= (record.counts?.reaction ?? 0)), "count sort order");
        assertions++;
      }
    });
    await measure("query.pagination", "workload", options.operations * 2, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const first = await queryRecords(db, config, { collection: "post", limit: 10 });
        check(first.cursor, "pagination cursor exists");
        const second = await queryRecords(db, config, { collection: "post", limit: 10, cursor: first.cursor });
        const uris = new Set(first.records.map((record) => record.uri));
        check(second.records.length > 0 && second.records.every((record) => !uris.has(record.uri)), "keyset pages do not overlap");
        assertions++;
      }
    });
    await measure("query.filter-pagination", "workload", options.operations * 2, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const first = await queryRecords(db, config, { collection: "post", filters: { category: "photos" }, limit: 5 });
        check(first.cursor, "filtered pagination cursor exists");
        const second = await queryRecords(db, config, { collection: "post", filters: { category: "photos" }, limit: 5, cursor: first.cursor });
        const uris = new Set(first.records.map((record) => record.uri));
        check(second.records.length > 0 && second.records.every((record) => !uris.has(record.uri) && JSON.parse(record.record!).category === "photos"), "filtered pages do not overlap or lose the filter");
        assertions++;
      }
    });
    const deepCursor = await measure("verify.filter-cursor", "verification", 1, "cursor-fixture", async () => {
      const post = posts[Math.floor(options.posts / 4) | 1]!;
      const result = await queryRecords(db, config, { collection: "post", limit: 1,
        source: { conditions: ["r.uri = ?"], params: [post.uri] },
      });
      check(result.cursor, "deep filtered cursor fixture");
      return result.cursor;
    });
    await measure("query.filter-deep-page", "workload", options.operations, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const result = await queryRecords(db, config, { collection: "post", filters: { category: "photos" }, limit: 5, cursor: deepCursor });
        check(result.records.length > 0 && result.records.every((record) => JSON.parse(record.record!).category === "photos"), "deep filtered page");
        assertions++;
      }
    });
    if (full) await measure("query.feed", "workload", options.operations, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const result = await queryRecords(db, config, { collection: "post", limit: 20, source: {
          joins: "JOIN feed_items f ON f.uri = r.uri", conditions: ["f.actor = ?"], params: [actor(1)],
        } });
        check(result.records.length > 0 && result.records.length <= 20, "feed page");
        assertions++;
      }
    });
    await measure("query.hydrate", "workload", options.operations, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const result = await runPipeline(db, config, "post", new URLSearchParams({
          limit: "20", hydrateComments: "3", hydrateReactions: "3", profiles: full ? "true" : "false",
        }));
        check(result.records.length > 0 && (!full || (result.profiles?.length ?? 0) > 0), "hydration/profile response");
        assertions++;
      }
    });

    await measure("query.reference", "workload", options.operations, "request", async () => {
      for (let i = 0; i < options.operations; i++) {
        const result = await runPipeline(db, config, "comment", new URLSearchParams({ limit: "20", hydratePost: "true" }));
        check(result.records.length > 0 && result.records.every((record) => record.post && typeof record.post === "object"), "reference hydration");
        assertions++;
      }
    });

    if (moderated) {
      const targets = fixture.reactions.slice(0, Math.min(options.operations, fixture.reactions.length));
      const hides = targets.map((reaction) => label(reaction.uri));
      await measure("moderation.label-hide", "workload", hides.length, "label", () => labels(hides));
      await verify("label-hide", async () => {
        for (const reaction of targets) await visible(reaction.uri, false, "reaction");
        await countsCorrect();
      });
      await measure("moderation.label-replay", "workload", hides.length, "label", () => labels(hides));
      const negatives = hides.map((hide) => ({ ...hide, neg: true, cts: new Date(now - 5_000).toISOString() }));
      await measure("moderation.label-retract", "workload", negatives.length, "label", () => labels(negatives));
      await verify("label-retract", async () => {
        for (const reaction of targets) await visible(reaction.uri, true, "reaction");
        await countsCorrect();
      });
      await measure("moderation.account-hide", "workload", 1, "account", () => labels([label(actor(0))]));
      await verify("account-hide", async () => { await visible(posts[0]!.uri, false); await countsCorrect(); });
      await measure("moderation.account-restore", "workload", 1, "account", () =>
        labels([label(actor(0), { neg: true, cts: new Date(now - 5_000).toISOString() })]));
      await verify("account-restore", async () => { await visible(posts[0]!.uri, true); await countsCorrect(); });
      for (const active of [false, true]) {
        await measure(`moderation.status-${active ? "restore" : "deactivate"}`, "workload", 1, "account", async () => {
          await db.batch(accountUpdateStatements(db, [{ did: actor(0), active, status: active ? undefined : "deactivated", timeUs: active ? 2 : 1, cursor: active ? 2 : 1 }], config));
          await drainRecounts();
        });
        await verify(`status-${active}`, async () => { await visible(posts[0]!.uri, active); await countsCorrect(); });
      }
      const action = event(MODERATION_ACTION_NSID, MODERATOR, "hide", {
        $type: MODERATION_ACTION_NSID, subject: posts[0]!.uri, action: "!hide", createdAt: new Date(now - 1_000).toISOString(),
      });
      await measure("moderation.action-create", "workload", 1, "action", async () => { await ingest([action]); await drainRecounts(); });
      await verify("action-hide", () => visible(posts[0]!.uri, false));
      await measure("moderation.action-delete", "workload", 1, "action", async () => {
        await ingest([event(MODERATION_ACTION_NSID, MODERATOR, action.rkey, null, "delete")]);
        await drainRecounts();
      });
      await verify("action-restore", () => visible(posts[0]!.uri, true));

      await measure("moderation.expiry-fixture", "setup", 1, "label", () => labels([
        label(posts[0]!.uri, { cts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString() }),
      ]));
      now += 61_000;
      await measure("moderation.expiry", "workload", 1, "expiry", () => drainRecounts());
      await verify("expiry", async () => { await visible(posts[0]!.uri, true); await countsCorrect(); });
      assertions += await runReportWorkloads(db, config, meter, options.operations, options.actors);
    }

    await measure("maintenance.schema-check", "workload", 1, "initialization", () => initSchema(db, config));
    await measure("maintenance.moderation-idle", "workload", options.operations, "cycle", async () => {
      for (let i = 0; i < options.operations; i++) {
        const result = await runModerationCycle(db, config, Date.now() + 60_000, { reconcile: false });
        check(!result.backfilled && !result.recountPages, "idle maintenance has no pending work");
      }
    });
    if (full) await measure("maintenance.feed-sweep", "workload", 1, "page", async () => {
      const result = await sweepFeedItems(db, buildFeedTargetCaps(config), null, 5);
      meter.note("rowsPruned", result.pruned);
    });

    const beforeFlood = await measure("verify.storage-before-flood", "verification", 1, "snapshot", storage);
    for (const manyActors of [false, true]) {
      const flood = Array.from({ length: options.operations }, (_, i) => event(NSIDS.post,
        manyActors ? `did:plc:sybil${String(i).padStart(8, "0")}` : "did:plc:floodpublisher", `flood${manyActors ? "many" : "one"}${i}`, fixture.value(i)));
      await measure(`abuse.${manyActors ? "many-publishers" : "single-publisher"}`, "workload", flood.length, "record", async () => {
        const result = await ingest(flood);
        check(result.accepted === flood.length, "current open admission accepts discoverable publishers");
      });
    }
    const afterFlood = await measure("verify.storage-after-flood", "verification", 1, "snapshot", storage);
    // Demonstrate why recordFilter is not a cheap abuse firewall: exclusions
    // still have source-ordering/tombstone/diagnostic/checkpoint costs.
    const filteredConfig = resolveConfig({ ...config, collections: { ...config.collections, post: { ...config.collections.post!, recordFilter: () => false } } });
    const filtered = Array.from({ length: options.operations }, (_, i) => event(NSIDS.post, "did:plc:filteredpublisher", `filtered${i}`, fixture.value(i)));
    await measure("abuse.record-filter", "workload", filtered.length, "observation", async () => {
      const result = await ingest(filtered, filteredConfig, true);
      check(result.accepted === 0 && result.drops.recordFilter === filtered.length, "record filter rejects visible records");
    });
    const finalStorage = await measure("verify.final", "verification", 1, "snapshot", async () => {
      check(afterFlood.records_post! - beforeFlood.records_post! === options.operations * 2, "flood retained-record growth");
      check(afterFlood.record_versions! - beforeFlood.record_versions! === options.operations * 2, "flood ordering-state growth");
      for (const post of filtered) await visible(post.uri, false);
      const cursor = await getLastCursor(db);
      check(cursor === Number(filtered.at(-1)!.source!.cursor), "source progress advances through filtered flood");
      check(networkAttempts === 0, "no network enrichment/acquisition");
      assertions += 4;
      await countsCorrect();
      const final = await storage();
      check(final.records_post === afterFlood.records_post && final.record_versions! - afterFlood.record_versions! === filtered.length,
        "filtered records leave ordering state, not retained records");
      assertions++;
      return { ...final, sourceCursor: cursor! };
    });
    return {
      fixture: options, phases: meter.phases, accountingSanity,
      correctness: { passed: true as const, assertions, networkAttempts },
      storage: { seeded: seededStorage, beforeFlood, afterFlood, final: finalStorage },
      protection: { admissionLimitsImplemented: false, openFloodAccepted: options.operations * 2 },
    };
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
}
