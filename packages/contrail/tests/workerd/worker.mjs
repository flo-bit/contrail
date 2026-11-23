import { createWorker } from "../../dist/worker/index.js";

const JETSTREAM_V2_SEQ_THRESHOLD = 1_000_000_000_000_000;

let cachedWorker = null;
let cachedJetstream = null;

function getWorker(env) {
  const jetstream = env.JETSTREAM_URL;
  if (!jetstream) {
    throw new Error("Missing JETSTREAM_URL var in workerd smoke worker");
  }
  if (cachedWorker && cachedJetstream === jetstream) return cachedWorker;
  cachedJetstream = jetstream;
  cachedWorker = createWorker(
    {
      namespace: "com.example",
      profiles: [],
      constellation: false,
      jetstreams: [jetstream],
      orderedSource: {
        source: "jetstream",
        epoch: "contrail-workerd-runtime-smoke-v1",
      },
      collections: {
        post: { collection: "app.bsky.feed.post" },
      },
      logger: console,
    },
    {
      scheduledIngest: {
        maxDrainMs: 8_000,
        maxCandidates: 1,
        maxIdentityUpdates: 1,
        maxSerializedBytes: 1024 * 1024,
      },
      backfillRetries: false,
    },
  );
  return cachedWorker;
}

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
    const worker = getWorker(env);
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
    return worker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return getWorker(env).scheduled(event, env, ctx);
  },
};
