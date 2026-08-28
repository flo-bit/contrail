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
import type { ScheduledIngestOptions } from "../core/jetstream.js";
import {
  runChangeDeliverySlice,
  validateDeliveryHandlers,
  type CurrentBootstrapRuntimeHandlers,
  type DeliveryHandlers,
  type DeliveryRuntimeOptions,
} from "../core/delivery.js";
import {
  normalizePublicServiceEndpoint,
  validatePublicServiceAuthEndpoint,
  validatePublicServiceLexicons,
  type PublicServiceOptions,
} from "../public-service.js";

type WorkerEnv = Record<string, unknown>;

export interface CreateWorkerOptions<Env extends WorkerEnv = WorkerEnv> {
  /** D1 binding name in wrangler env. Default: `"DB"`. */
  binding?: string;
  /** Exact generated/pinned bundle exposed for type generation and used by
   * collections with `validate: true`. */
  lexicons?: object[];
  /** Enable stable discovery and Lexicon routes for anonymous remote clients. */
  publicService?: PublicServiceOptions;
  /** Count, byte, and drain-time limits for each scheduled Jetstream cycle. */
  scheduledIngest?: ScheduledIngestOptions;
  /** Bounded pending-account retry slice after each scheduled ingest. Enabled
   *  by default; pass `false` to disable or options to tune its budget. */
  backfillRetries?: BackfillRetryOptions | false;
  /** Runtime delivery handlers, kept separate from static consumer policy. */
  deliveries?: DeliveryHandlers<Env>;
  /** Snapshot and activation handlers for `initial: "current"` consumers. */
  changeBootstraps?: CurrentBootstrapRuntimeHandlers<Env>;
  /** Bounded scheduled delivery policy. Set false only when another runtime
   * owns all configured consumers. */
  delivery?: DeliveryRuntimeOptions | false;
  /** Runs once per isolate, after schema init, before handling the first
   *  request. Use for app-specific setup that needs a live DB handle. */
  onInit?: (env: Env, db: Database) => void | Promise<void>;
}

export function createWorker<Env extends WorkerEnv = WorkerEnv>(
  config: ContrailConfig,
  options: CreateWorkerOptions<Env> = {}
) {
  const binding = options.binding ?? "DB";
  const deliveryEnabled =
    options.delivery !== false &&
    Object.keys(config.changes?.consumers ?? {}).length > 0;
  if (deliveryEnabled) {
    validateDeliveryHandlers(
      config,
      options.deliveries ?? {},
      options.changeBootstraps ?? {},
    );
  }
  if (options.publicService) {
    normalizePublicServiceEndpoint(options.publicService.endpoint);
    validatePublicServiceLexicons(config, options.lexicons ?? []);
    validatePublicServiceAuthEndpoint(config, options.publicService);
  }
  const contrail = new Contrail({ ...config, lexicons: options.lexicons });
  const handle = createHandler(contrail, {
    lexicons: options.lexicons,
    publicService: options.publicService,
  });

  let ready = false;
  const ensureReady = async (env: Env, db: Database): Promise<void> => {
    if (ready) return;
    await contrail.init(db);
    await options.onInit?.(env, db);
    ready = true;
  };

  return {
    async fetch(
      request: Request,
      env: Env,
      ctx?: ExecutionContext,
    ): Promise<Response> {
      const db = env[binding] as Database;
      await ensureReady(env, db);
      const response = (await handle(request, db)) as Response;
      const notifyPath = `/xrpc/${contrail.config.namespace}.notifyOfUpdate`;
      if (
        deliveryEnabled &&
        ctx &&
        response.ok &&
        request.method === "POST" &&
        new URL(request.url).pathname === notifyPath
      ) {
        ctx.waitUntil(
          runChangeDeliverySlice({
            changes: contrail.changes,
            config: contrail.config,
            db,
            env,
            deliveries: options.deliveries!,
            bootstraps: options.changeBootstraps,
            runtime: {
              ...(options.delivery || {}),
              maxRounds: 1,
              maxDurationMs: Math.min(
                options.delivery && options.delivery.maxDurationMs
                  ? options.delivery.maxDurationMs
                  : 5_000,
                5_000,
              ),
            },
          }).catch((error) => {
            contrail.config.logger?.error(
              `[changes] immediate delivery wake failed: ${error}`,
            );
          }),
        );
      }
      return response;
    },
    async scheduled(
      _event: ScheduledEvent,
      env: Env,
      ctx: ExecutionContext
    ): Promise<void> {
      const db = env[binding] as Database;
      await ensureReady(env, db);
      // Keep live catch-up first, then spend a bounded slice on due historical
      // failures. A database lease prevents overlap with a manual backfill.
      ctx.waitUntil(
        (async () => {
          try {
            await contrail.ingest(options.scheduledIngest, db);
          } catch (error) {
            contrail.config.logger?.error(
              `[ingest] scheduled cycle failed: ${error}`,
            );
          }
          if (options.backfillRetries !== false) {
            try {
              await contrail.retryBackfill(options.backfillRetries, db);
            } catch (error) {
              contrail.config.logger?.error(
                `[backfill] scheduled retry slice failed: ${error}`,
              );
            }
          }
          if (deliveryEnabled) {
            try {
              await runChangeDeliverySlice({
                changes: contrail.changes,
                config: contrail.config,
                db,
                env,
                deliveries: options.deliveries!,
                bootstraps: options.changeBootstraps,
                runtime: options.delivery || undefined,
              });
            } catch (error) {
              contrail.config.logger?.error(
                `[changes] scheduled delivery slice failed: ${error}`,
              );
            }
          }
        })()
      );
    },
  };
}
