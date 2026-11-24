import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContrailConfig, Database } from "../types";
import { normalizeProfileConfig } from "../types";
import { backfillUser } from "../backfill";
import { attachRecordLabels } from "../labels/attach";
import { selectAcceptedLabelers } from "../labels/select";
import { resolveActor } from "../identity";
import { getStatusOverview, registerCursorRoute } from "./diagnostics";
import { registerCollectionRoutes } from "./collection";
import { registerFeedRoutes } from "./feed";
import { registerNotifyRoute } from "./notify";
import { hiddenProfileUris, resolveProfiles } from "./profiles";
import { createServiceAuthGate } from "../service-auth";
import { isAccountHidden } from "../moderation";
import { registerModerationRoutes } from "./moderation";
import {
  describePublicService,
  hostsServiceDidDocument,
  normalizeLexiconDocuments,
  normalizePublicServiceEndpoint,
  validatePublicServiceAuthEndpoint,
  validatePublicServiceLexicons,
  type PublicServiceDescription,
  type PublicServiceOptions,
} from "../../public-service";

/** Internal Hono env keys used by `createHandler` to inject per-request D1
 *  bindings without rebuilding the router or validation cache per request. */
export const REQUEST_DB = Symbol("contrail.requestDb");
export const REQUEST_REPORTS_DB = Symbol("contrail.requestReportsDb");

export interface RouterRequestBindings {
  [REQUEST_DB]?: Database;
  [REQUEST_REPORTS_DB]?: Database;
}

export type DatabaseResolver = Database | ((c: Context) => Database);

export function resolveRequestDb(db: DatabaseResolver, c: Context): Database {
  return typeof db === "function" ? db(c) : db;
}

export interface CreateAppOptions {
  /** Lexicon JSON documents to expose from the deployment. */
  lexicons?: object[];
  /** Enable stable discovery for anonymous read-through clients. */
  publicService?: PublicServiceOptions;
  /** Stable instance-owned report storage, independent of projection rebuilds. */
  reportsDb?: Database;
}

export function createApp(
  db: Database,
  config: ContrailConfig,
  options: CreateAppOptions = {},
): Hono {
  return createRouterApp(db, config, options);
}

/** Internal router builder that allows `defaultDb` to be omitted when every
 *  request supplies `REQUEST_DB` via Hono env (e.g. `createHandler` / Workers). */
export function createRouterApp(
  defaultDb: Database | undefined,
  config: ContrailConfig,
  options: CreateAppOptions = {},
): Hono {
  const getDb = (c: Context): Database => {
    const db = (c.env as RouterRequestBindings | undefined)?.[REQUEST_DB] ?? defaultDb;
    if (!db) {
      throw new Error("No database provided. Pass db to constructor or to this method.");
    }
    return db;
  };
  const getReportsDb = (c: Context): Database =>
    (c.env as RouterRequestBindings | undefined)?.[REQUEST_REPORTS_DB] ??
    options.reportsDb ??
    getDb(c);

  const app = new Hono();
  app.use(
    "*",
    cors({
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Atproto-Accept-Labelers",
      ],
      exposeHeaders: ["Atproto-Content-Labelers", "WWW-Authenticate"],
    }),
  );
  const serviceAuth = createServiceAuthGate(config);

  app.get("/", (c) => c.json({ status: "ok" }));
  app.get("/status", async (c) => {
    const overview = await getStatusOverview(getDb(c), config);
    if (!options.publicService) return c.json(overview);
    c.header("cache-control", "public, max-age=15, stale-while-revalidate=45");
    return c.json({
      status: overview.status,
      serving: "ready",
      total_records: overview.total_records,
      collections: overview.collections,
      freshness: {
        last_event_at: overview.ingestion.date,
        seconds_ago: overview.ingestion.seconds_ago,
      },
      backfill: overview.backfill,
    });
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/xrpc/_health", (c) => c.json({ status: "ok" }));

  const ns = config.namespace;
  const lexicons = options.publicService
    ? normalizeLexiconDocuments(options.lexicons ?? [])
    : (options.lexicons ?? []);
  if (options.publicService) {
    const publicService = options.publicService;
    const publicEndpoint = normalizePublicServiceEndpoint(
      publicService.endpoint,
      publicService,
    );
    validatePublicServiceLexicons(config, lexicons);
    validatePublicServiceAuthEndpoint(config, publicService);
    let descriptionPromise: Promise<PublicServiceDescription> | null = null;
    const getDescription = () =>
      (descriptionPromise ??= describePublicService(
        config,
        publicService,
        lexicons,
      ));
    app.get("/.well-known/contrail", async (c) => {
      const { manifest } = await getDescription();
      c.header("cache-control", "public, max-age=60");
      return c.json(manifest);
    });
    if (
      serviceAuth &&
      hostsServiceDidDocument(serviceAuth.serviceDid, publicEndpoint)
    ) {
      app.get("/.well-known/did.json", (c) => {
        c.header("content-type", "application/did+ld+json; charset=UTF-8");
        c.header("cache-control", "public, max-age=300");
        return c.body(
          JSON.stringify({
            "@context": ["https://www.w3.org/ns/did/v1"],
            id: serviceAuth.serviceDid,
            service: [
              {
                id: serviceAuth.audience,
                type: "ContrailService",
                serviceEndpoint: publicEndpoint,
              },
            ],
          }),
        );
      });
    }
    app.get("/lexicons", async (c) => {
      const service = await getDescription();
      c.header("content-type", "application/json; charset=UTF-8");
      c.header("cache-control", "no-cache");
      c.header("etag", `\"${service.manifest.lexicons.digest}\"`);
      return c.body(service.canonicalLexicons);
    });
    app.get("/lexicons/:digest", async (c) => {
      const service = await getDescription();
      if (c.req.param("digest") !== service.manifest.lexicons.digest) {
        return c.json({ error: "Lexicon bundle not found" }, 404);
      }
      c.header("content-type", "application/json; charset=UTF-8");
      c.header("cache-control", "public, max-age=31536000, immutable");
      c.header("etag", `\"${service.manifest.lexicons.digest}\"`);
      return c.body(service.canonicalLexicons);
    });
  }
  if (lexicons.length > 0) {
    app.get(`/xrpc/${ns}.lexicons`, (c) => c.json({ lexicons }));
  }

  app.get(`/xrpc/${ns}.getProfile`, async (c) => {
    const db = getDb(c);
    const actor = c.req.query("actor");
    if (!actor) return c.json({ error: "actor parameter required" }, 400);

    const did = await resolveActor(db, actor, config);
    if (!did) return c.json({ error: "Could not resolve actor" }, 400);

    if (await isAccountHidden(db, did)) return c.json({ error: "Profile not found" }, 404);
    const profilesToLoad = (config.profiles ?? []).map(normalizeProfileConfig);
    const hiddenUris = await hiddenProfileUris(db, config, [did]);
    if (profilesToLoad.length && profilesToLoad.every((p) =>
      hiddenUris.has(`at://${did}/${p.collection}/${p.rkey ?? "self"}`),
    )) return c.json({ error: "Profile not found" }, 404);
    for (const profile of profilesToLoad) {
      if (hiddenUris.has(`at://${did}/${profile.collection}/${profile.rkey ?? "self"}`)) continue;
      await backfillUser(
        db,
        did,
        profile.collection,
        Date.now() + 3_000,
        config,
        { maxRetries: 0, requestTimeout: 3_000 },
      );
    }

    const profileMap = await resolveProfiles(db, config, [did]);
    const profiles = profileMap[did];
    if (!profiles || profiles.length === 0) {
      return c.json({ error: "Profile not found" }, 404);
    }

    if (config.labels) {
      const params = new URL(c.req.url).searchParams;
      const selection = selectAcceptedLabelers(
        c.req.raw.headers.get("atproto-accept-labelers"),
        params.get("labelers"),
        config.labels,
      );
      if (selection.accepted.length > 0) {
        await attachRecordLabels(db, [], [], selection.accepted, profiles);
        c.header("atproto-content-labelers", selection.accepted.join(","));
      }
    }

    return c.json({ profiles });
  });

  registerCursorRoute(app, getDb, config);
  registerCollectionRoutes(app, getDb, config);
  registerFeedRoutes(app, getDb, config, serviceAuth);
  registerNotifyRoute(app, getDb, config, serviceAuth);
  registerModerationRoutes(app, getDb, config, serviceAuth, getReportsDb);

  return app;
}
