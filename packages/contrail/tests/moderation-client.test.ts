import { beforeAll, describe, expect, it, vi } from "vitest";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import type { Client } from "@atcute/client";
import type { AtprotoAudience, Did, Nsid } from "@atcute/lexicons/syntax";
import { createTestDb } from "./helpers";
import { createApp, initSchema, resolveConfig } from "../src/index";
import {
  createModerationAction,
  deleteModerationAction,
  listReports,
  loadReportInboxes,
  moderationOAuthScope,
  resolveReport,
  submitReport,
  type ModerationService,
  type ReportSubject,
} from "../src/moderation-client";

const service: ModerationService = {
  endpoint: "https://api.example.com",
  audience: "did:web:api.example.com#contrail",
  namespace: "com.example",
};
const subject: ReportSubject = {
  $type: "com.atproto.admin.defs#repoRef",
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
};

/** Records PDS calls; `getServiceAuth` returns `token`. */
function fakeClient(token: () => Promise<string> | string = () => "service-token") {
  const calls: Array<{ method: string; options: any }> = [];
  const client = {
    async get(method: string, options: any) {
      calls.push({ method, options });
      return { ok: true, status: 200, data: { token: await token() } };
    },
    async post(method: string, options: any) {
      calls.push({ method, options });
      return { ok: true, status: 200, data: { uri: "at://action", cid: "cid" } };
    },
  };
  return { calls, client: client as unknown as Client };
}

describe("moderation client", () => {
  it("binds the exact audience/method and never forwards OAuth tokens", async () => {
    const { calls, client } = fakeClient();
    const requests: Array<{ url: URL; options: RequestInit }> = [];
    await submitReport({
      client,
      service,
      subject,
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      reason: "private",
      fetch: async (url, options) => {
        requests.push({ url: url as URL, options: options! });
        return Response.json({ id: 1, createdAt: "now" });
      },
    });
    expect(calls[0]!.method).toBe("com.atproto.server.getServiceAuth");
    expect(calls[0]!.options.params).toEqual({
      aud: service.audience,
      lxm: "com.atproto.moderation.createReport",
    });
    const options = requests[0]!.options;
    expect((options.headers as Record<string, string>).authorization).toBe(
      "Bearer service-token",
    );
    expect(options.redirect).toBe("manual");
    // Server runtimes get no browser-only options (some reject them).
    expect((options as { credentials?: string }).credentials).toBeUndefined();
    expect(JSON.parse(options.body as string).reason).toBe("private");
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects HTTP %s redirects without parsing the body or following them",
    async (status) => {
      const { client } = fakeClient();
      const response = new Response("<html>redirect</html>", {
        status,
        headers: { location: "https://elsewhere.example" },
      });
      const json = vi.spyOn(response, "json");
      const fetch = vi.fn(async (_url, init: RequestInit | undefined) => {
        expect(init?.redirect).toBe("manual");
        return response;
      });
      await expect(listReports({ client, service, fetch })).rejects.toMatchObject({
        status,
        error: "RedirectNotAllowed",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("rejects opaque browser redirects before reading their inaccessible body", async () => {
    const { client } = fakeClient();
    const response = new Response();
    Object.defineProperties(response, {
      type: { value: "opaqueredirect" },
      status: { value: 0 },
    });
    const json = vi.spyOn(response, "json");
    await expect(listReports({
      client, service, fetch: async () => response,
    })).rejects.toMatchObject({ status: 0, error: "RedirectNotAllowed" });
    expect(json).not.toHaveBeenCalled();
  });

  it("omits cookies and caching in browsers", async () => {
    const { client } = fakeClient();
    let init: RequestInit | undefined;
    (globalThis as any).document = {};
    try {
      await listReports({
        client,
        service,
        fetch: async (_url, options) => {
          init = options;
          return Response.json({ reports: [] });
        },
      });
    } finally {
      delete (globalThis as any).document;
    }
    expect((init as { credentials?: string } | undefined)?.credentials).toBe("omit");
    expect(init?.cache).toBe("no-store");
  });

  it("builds granular rpc scopes and rejects malformed audiences", () => {
    expect(moderationOAuthScope(service, true).split(" ")).toEqual([
      "rpc?lxm=com.atproto.moderation.createReport&aud=did%3Aweb%3Aapi.example.com%23contrail",
      "rpc?lxm=com.example.moderation.listReports&aud=did%3Aweb%3Aapi.example.com%23contrail",
      "rpc?lxm=com.example.moderation.resolveReport&aud=did%3Aweb%3Aapi.example.com%23contrail",
    ]);
    expect(() =>
      moderationOAuthScope({
        ...service,
        audience: "did:web:api.example.com#one#two" as AtprotoAudience,
      }),
    ).toThrow("exactly one fragment");
  });

  it("binds each inbox token to its precise query/procedure", async () => {
    const { calls, client } = fakeClient();
    const fetch = async () => Response.json({ reports: [] });
    await listReports({ client, service, fetch });
    await resolveReport({ client, service, id: 123, fetch });
    expect(calls.map((call) => call.options.params.lxm)).toEqual([
      "com.example.moderation.listReports",
      "com.example.moderation.resolveReport",
    ]);
  });

  it("fans out with source provenance and reports partial failures", async () => {
    const { client } = fakeClient();
    const second = {
      ...service,
      endpoint: "https://second.example",
      audience: "did:web:second.example#contrail" as AtprotoAudience,
    };
    const result = await loadReportInboxes({
      client,
      services: [service, second],
      fetch: async (url) =>
        (url as URL).hostname === "second.example"
          ? Response.json({ error: "Forbidden" }, { status: 403 })
          : Response.json({
              reports: [{ id: 1, subject, createdAt: "2026-01-01T00:00:00Z" }],
              cursor: "next",
            }),
    });
    expect(result.reports[0]!.service.endpoint).toBe(service.endpoint);
    expect(result.failures[0]!.service.endpoint).toBe(second.endpoint);
    expect(result.cursors[service.endpoint]).toBe("next");
  });

  it("never publishes private fields and only undoes own action records", async () => {
    const { calls, client } = fakeClient();
    await createModerationAction({
      client,
      did: subject.did,
      subject: subject.did,
      action: "!hide",
      // Extra fields a caller might spread in from a report.
      ...({ reason: "must not leak", notes: "private" } as object),
    });
    for (const labels of [[], [""]])
      await expect(
        createModerationAction({
          client,
          did: subject.did,
          subject: subject.did,
          action: "override",
          labels,
        }),
      ).rejects.toThrow("Override labels must be nonempty");
    expect(calls).toHaveLength(1);
    const record = calls[0]!.options.input.record;
    expect(record.reason).toBeUndefined();
    expect(record.notes).toBeUndefined();
    expect(record.action).toBe("!hide");
    await expect(
      deleteModerationAction({
        client,
        did: subject.did,
        uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/tools.atmo.moderation.action/a",
      }),
    ).rejects.toThrow("own repository");
  });

  it("rejects unsafe service destinations before minting a token", async () => {
    const { calls, client } = fakeClient();
    for (const endpoint of ["http://evil.example", "https://api.example.com/path"]) {
      await expect(
        submitReport({
          client,
          service: { ...service, endpoint },
          subject,
          reasonType: "com.atproto.moderation.defs#reasonSpam",
        }),
      ).rejects.toThrow("public service endpoint");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("moderation client against Contrail routes", () => {
  const moderator = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as Did;
  const reporter = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" as Did;
  let key: Secp256k1PrivateKeyExportable;
  beforeAll(async () => {
    key = await Secp256k1PrivateKeyExportable.createKeypair();
  });

  it("submits, lists and resolves a report end to end", async () => {
    const config = resolveConfig({
      namespace: service.namespace,
      collections: {},
      profiles: [],
      moderation: { moderators: [moderator] },
      serviceAuth: {
        audience: service.audience,
        methods: [],
        resolver: {
          async resolve(did) {
            return {
              "@context": [],
              id: did,
              verificationMethod: [
                {
                  id: `${did}#atproto`,
                  type: "Multikey",
                  controller: did,
                  publicKeyMultibase: await key.exportPublicKey("multikey"),
                },
              ],
            };
          },
        },
      },
    });
    const db = createTestDb();
    await initSchema(db, config);
    // Reports are only accepted for subjects the instance indexes.
    await db
      .prepare("INSERT INTO identities (did, pds, resolved_at) VALUES (?, ?, ?)")
      .bind(subject.did, "https://pds.example", Date.now())
      .run();
    const app = createApp(db, config);
    const fetch = (async (url: URL, init?: RequestInit) =>
      app.request(url.pathname + url.search, init)) as typeof globalThis.fetch;
    // A PDS stand-in that mints real service JWTs for the requested method.
    const session = (issuer: Did) => {
      let lxm: Nsid;
      const { client } = fakeClient(() =>
        createServiceJwt({ keypair: key, issuer, audience: service.audience, lxm }),
      );
      const get = client.get.bind(client);
      (client as any).get = (method: string, options: any) => {
        lxm = options.params.lxm;
        return get(method as any, options);
      };
      return client;
    };

    const created = await submitReport({
      client: session(reporter),
      service,
      subject,
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      reason: "private evidence",
      fetch,
    });
    const page = await listReports({ client: session(moderator), service, fetch });
    expect(page.reports.map((r) => [r.id, r.reason])).toEqual([
      [created.id, "private evidence"],
    ]);
    await resolveReport({ client: session(moderator), service, id: created.id, fetch });
    const resolved = await listReports({
      client: session(moderator),
      service,
      status: "resolved",
      fetch,
    });
    expect(resolved.reports[0]!.status).toBe("resolved");
    await expect(
      listReports({ client: session(reporter), service, fetch }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
