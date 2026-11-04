import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import {
  createApp,
  createModerationReports,
  initModerationReports,
  initSchema,
  resolveConfig,
  ModerationReportError,
} from "../src/index";

const moderator = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const reporter = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const report = {
  subject: { $type: "com.atproto.admin.defs#repoRef", did: reporter },
  reasonType: "com.atproto.moderation.defs#reasonSpam",
  reason: "Private evidence",
};

async function setup() {
  const config = resolveConfig({
    namespace: "com.example",
    collections: {},
    profiles: [],
    moderation: { moderators: [moderator], reports: false },
  });
  const projectionDb = createTestDb();
  const reportsDb = createTestDb();
  await initSchema(projectionDb, config);
  await initModerationReports(reportsDb);
  await projectionDb
    .prepare("INSERT INTO identities (did, pds, resolved_at) VALUES (?, ?, ?)")
    .bind(reporter, "https://pds.example", Date.now())
    .run();
  const reports = createModerationReports({ projectionDb, reportsDb, config });
  return { config, projectionDb, reportsDb, reports };
}

describe("session-backed report operations", () => {
  it("works without service auth and does not expose anonymous XRPC routes", async () => {
    const { config, projectionDb, reportsDb, reports } = await setup();
    expect(config.serviceAuth).toBeUndefined();
    const created = await reports.create(reporter, {
      ...report,
      reportedBy: moderator,
    });
    expect(created.reportedBy).toBe(reporter);
    const inbox = await reports.list(moderator);
    expect(inbox.reports).toHaveLength(1);
    expect(inbox.reports[0].reason).toBe(report.reason);
    expect(
      (await projectionDb.prepare("SELECT * FROM moderation_reports").all())
        .results,
    ).toEqual([]);
    const app = createApp(projectionDb, config, { reportsDb });
    for (const [method, path] of [
      ["POST", "com.atproto.moderation.createReport"],
      ["GET", "com.example.moderation.listReports"],
      ["POST", "com.example.moderation.resolveReport"],
    ]) {
      expect((await app.request(`/xrpc/${path}`, { method })).status).toBe(404);
    }
  });

  it("requires a valid authenticated actor and authorizes every moderator operation", async () => {
    const { reports } = await setup();
    for (const actor of ["", "not-a-did", undefined as any]) {
      await expect(reports.create(actor, report)).rejects.toMatchObject({
        status: 401,
      });
      await expect(reports.list(actor)).rejects.toMatchObject({ status: 401 });
      await expect(reports.resolve(actor, { id: 1 })).rejects.toMatchObject({
        status: 401,
      });
    }
    await expect(reports.list(reporter)).rejects.toMatchObject({ status: 403 });
    await expect(reports.resolve(reporter, { id: 1 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("shares subject/reason validation and transaction-safe quotas with the HTTP API", async () => {
    const { reports, reportsDb } = await setup();
    for (const input of [
      null,
      [],
      "bad",
      {},
      { ...report, reason: "a".repeat(2001) },
      { ...report, reasonType: "bad" },
      { ...report, subject: { ...report.subject, did: moderator } },
    ]) {
      await expect(reports.create(reporter, input)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(
      (await reportsDb.prepare("SELECT * FROM moderation_report_limits").all())
        .results,
    ).toEqual([]);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => reports.create(reporter, report)),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    for (const r of outcomes)
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ModerationReportError);
        expect(r.reason).toMatchObject({ status: 429, retryAfter: 3600 });
      }
  });

  it("paginates, resolves idempotently and keeps private state across projection replacements", async () => {
    const { reports, reportsDb, config } = await setup();
    for (let i = 0; i < 3; i++) await reports.create(reporter, report);
    await reportsDb
      .prepare("UPDATE moderation_reports SET created_at = 123")
      .run();
    const first = await reports.list(moderator, { limit: 2 });
    const next = await reports.list(moderator, {
      limit: 2,
      cursor: first.cursor,
    });
    expect(next.reports).toHaveLength(1);
    expect(first.reports.map((r) => r.id)).not.toContain(next.reports[0].id);
    await expect(
      reports.list(moderator, { cursor: "invalid" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(reports.list(moderator, { limit: 101 })).rejects.toMatchObject(
      { status: 400 },
    );
    const id = first.reports[0].id;
    await reports.resolve(moderator, { id, resolution: "Done" });
    await reports.resolve(moderator, { id, resolution: "Overwrite" });
    await expect(reports.resolve(moderator, { id: 0 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      reports.resolve(moderator, {
        id,
        actionUri: `at://${reporter}/tools.atmo.moderation.action/a`,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const projectionDb = createTestDb();
    await initSchema(projectionDb, config);
    const replacement = createModerationReports({
      projectionDb,
      reportsDb,
      config,
    });
    const resolved = await replacement.list(moderator, { status: "resolved" });
    expect(resolved.reports[0]).toMatchObject({ id, resolution: "Done" });
    expect((await replacement.list(moderator)).reports).toHaveLength(2);
  });
});
