import { createWorker } from "../../dist/worker/index.js";
import { getMeta, hydrateLabels, initSchema, resolveConfig } from "../../dist/index.js";

const JETSTREAM_V2_SEQ_THRESHOLD = 1_000_000_000_000_000;

const config = {
  namespace: "com.example",
  profiles: [],
  constellation: false,
  jetstreams: ["https://jetstream.us-east.bsky.network"],
  orderedSource: {
    source: "jetstream",
    epoch: "contrail-workerd-runtime-smoke-v1",
  },
  collections: {
    post: { collection: "app.bsky.feed.post" },
  },
  logger: console,
};

const worker = createWorker(config, {
  scheduledIngest: {
    maxDrainMs: 8_000,
    maxCandidates: 1,
    maxIdentityUpdates: 1,
    maxSerializedBytes: 1024 * 1024,
  },
  backfillRetries: false,
});

function cpuUsageCapability() {
  const runtimeProcess = globalThis.process;
  const exposed = typeof runtimeProcess?.cpuUsage === "function";
  if (!exposed) return { exposed, throws: false };
  try {
    runtimeProcess.cpuUsage();
    return { exposed, throws: false };
  } catch (error) {
    return { exposed, throws: true, error: String(error) };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__contrail_workerd_smoke") {
      // Exercise the built Worker's lazy initialization before inspecting its
      // durable cursor directly through the real local D1 binding.
      await worker.fetch(new Request(new URL("/health", url)), env, ctx);
      const row = await env.DB.prepare(
        "SELECT time_us FROM cursor WHERE id = 1",
      ).first();
      const cursor = row?.time_us ?? null;
      return Response.json({
        cursor,
        cursorDomain:
          cursor === null
            ? null
            : cursor < JETSTREAM_V2_SEQ_THRESHOLD
              ? "seq"
              : "timestamp",
        cpuUsage: cpuUsageCapability(),
      });
    }
    if (url.pathname === "/__contrail_workerd_schema_repair" && request.method === "POST") {
      // Reproduce an existing D1 database with a valid fingerprint but no view.
      await worker.fetch(new Request(new URL("/health", url)), env, ctx);
      const resolved = resolveConfig(config);
      // Settle the fresh database's deferred policy job before measuring
      // schema-only recovery and the ordinary healthy fast path.
      await initSchema(env.DB, resolved);
      const fingerprint = await getMeta(env.DB, "schema_fingerprint");
      await env.DB.prepare("DROP VIEW moderation_effective_labels").run();
      const statements = [];
      const db = {
        prepare(sql) { statements.push(sql); return env.DB.prepare(sql); },
        batch: (batch) => env.DB.batch(batch),
      };
      // Match the Worker's request-path initialization: do not drain its
      // independently pending moderation-policy job as part of this test.
      await initSchema(db, resolved, { deferModerationPolicyJob: true });
      const repairStatements = statements.length;
      statements.length = 0;
      await initSchema(db, resolved, { deferModerationPolicyJob: true });
      const healthyStatements = statements.length;
      // This must actually query the recovered view, not merely inspect it.
      await hydrateLabels(env.DB, ["did:plc:test"], ["did:plc:labeler"]);
      return Response.json({
        fingerprintUnchanged: fingerprint !== null && fingerprint === await getMeta(env.DB, "schema_fingerprint"),
        repairStatements,
        healthyStatements,
      });
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
