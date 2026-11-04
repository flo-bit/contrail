import type { Hono, Context } from "hono";
import type { Nsid } from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database } from "../types";
import type { ServiceAuthGate } from "../service-auth";
import {
  createModerationReports,
  ModerationReportError,
} from "../moderation-reports";
export { REPORT_REASON_TYPES } from "../../moderation-contract";

// Leave room for JSON escape expansion of valid 20,000-byte reasons and
// their subject/envelope. Field-level limits still apply after parsing.
const MAX_JSON_BODY_BYTES = 128 * 1024;

async function smallJson(c: Context): Promise<any> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Body timeout"));
      reader.cancel().catch(() => {});
    }, 5_000);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error("Body too large");
      }
      parts.push(value);
    }
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  const parsed = JSON.parse(new TextDecoder().decode(body));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected object");
  return parsed;
}

export function registerModerationRoutes(
  app: Hono,
  projectionDb: Database,
  config: ContrailConfig,
  auth?: ServiceAuthGate | null,
  db: Database = projectionDb,
): void {
  if (!config.moderation || config.moderation.reports === false) return;
  if (!auth) throw new TypeError("Reports require serviceAuth.audience");
  const reports = createModerationReports({
    projectionDb,
    reportsDb: db,
    config,
  });
  const ns = config.namespace;
  const run = async (
    c: Context,
    method: string,
    operation: (actor: string) => Promise<unknown>,
  ) => {
    c.header("cache-control", "no-store");
    const result = await auth.authorize(c.req.raw, method as Nsid);
    if (result.response) return result.response;
    if (!result.principal?.issuer) return c.json({ error: "Forbidden" }, 403);
    try {
      return c.json((await operation(result.principal.issuer)) as object);
    } catch (error) {
      if (!(error instanceof ModerationReportError)) throw error;
      if (error.retryAfter) c.header("retry-after", String(error.retryAfter));
      return c.json(
        { error: error.error, message: error.message },
        error.status,
      );
    }
  };
  const body = async (c: Context) => {
    try {
      return await smallJson(c);
    } catch {
      throw new ModerationReportError(400, "InvalidRequest");
    }
  };
  app.post("/xrpc/com.atproto.moderation.createReport", (c) =>
    run(c, "com.atproto.moderation.createReport", async (actor) =>
      reports.create(actor, await body(c)),
    ),
  );
  app.get(`/xrpc/${ns}.moderation.listReports`, (c) =>
    run(c, `${ns}.moderation.listReports`, (actor) =>
      reports.list(actor, {
        status: (c.req.query("status") ?? "open") as "open" | "resolved",
        limit: Number(c.req.query("limit") ?? 50),
        cursor: c.req.query("cursor"),
      }),
    ),
  );
  app.post(`/xrpc/${ns}.moderation.resolveReport`, (c) =>
    run(c, `${ns}.moderation.resolveReport`, async (actor) =>
      reports.resolve(actor, await body(c)),
    ),
  );
}
