/**
 * Prebuilt Cloudflare Workers entrypoint for a contrail deployment.
 *
 * Collapses the ~12-line boilerplate of `new Contrail()` + `createHandler()` +
 * `{ fetch, scheduled }` down to:
 *
 *     import { createWorker } from "@atmo-dev/contrail/worker";
 *     import { config } from "./contrail.config";
 *     import { lexicons } from "./lexicons/generated"; // optional, enables /lexicons
 *     export default createWorker(config, { lexicons });
 *
 * The handler lazily inits the DB schema on first request per isolate,
 * registers every XRPC route, and runs live ingestion plus a bounded due
 * backfill-retry slice on the `scheduled` event. Pass `binding` if your D1 binding isn't named `DB`;
 * pass `onInit` for app-specific one-shot setup that needs the DB.
 */
import { Contrail } from "../contrail.js";
import { createHandler } from "../server.js";
import type { ContrailConfig, Database } from "../core/types.js";
import type { BackfillRetryOptions } from "../core/backfill.js";
import {
  normalizePublicServiceEndpoint,
  validatePublicServiceLexicons,
  type PublicServiceOptions,
} from "../public-service.js";

export interface CreateWorkerOptions {
  /** D1 binding name in wrangler env. Default: `"DB"`. */
  binding?: string;
  /** Exact generated/pinned bundle exposed for type generation and used by
   * collections with `validate: true`. */
  lexicons?: object[];
  /** Enable stable discovery and Lexicon routes for anonymous remote clients. */
  publicService?: PublicServiceOptions;
  /** Bounded pending-account retry slice after each scheduled ingest. Enabled
   *  by default; pass `false` to disable or options to tune its budget. */
  backfillRetries?: BackfillRetryOptions | false;
  /** Runs once per isolate, after schema init, before handling the first
   *  request. Use for app-specific setup that needs a live DB handle. */
  onInit?: (env: Record<string, unknown>, db: Database) => void | Promise<void>;
}

type WorkerEnv = Record<string, unknown>;

export function createWorker(
  config: ContrailConfig,
  options: CreateWorkerOptions = {}
) {
  const binding = options.binding ?? "DB";
  if (options.publicService) {
    normalizePublicServiceEndpoint(options.publicService.endpoint);
    validatePublicServiceLexicons(config, options.lexicons ?? []);
  }
  const contrail = new Contrail({ ...config, lexicons: options.lexicons });
  const handle = createHandler(contrail, {
    lexicons: options.lexicons,
    publicService: options.publicService,
  });

  let ready = false;
  const ensureReady = async (env: WorkerEnv, db: Database): Promise<void> => {
    if (ready) return;
    await contrail.init(db);
    await options.onInit?.(env, db);
    ready = true;
  };

  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const db = env[binding] as Database;
      await ensureReady(env, db);
      return (await handle(request, db)) as Response;
    },
    async scheduled(
      _event: ScheduledEvent,
      env: WorkerEnv,
      ctx: ExecutionContext
    ): Promise<void> {
      const db = env[binding] as Database;
      await ensureReady(env, db);
      // Keep live catch-up first, then spend a bounded slice on due historical
      // failures. A database lease prevents overlap with a manual backfill.
      ctx.waitUntil(
        (async () => {
          await contrail.ingest({}, db);
          if (options.backfillRetries !== false) {
            await contrail.retryBackfill(options.backfillRetries, db);
          }
        })()
      );
    },
  };
}
