import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContrailConfig, Database } from "../types";
import { normalizeProfileConfig } from "../types";
import { backfillUser } from "../backfill";
import { hydrateLabels } from "../labels/hydrate";
import { selectAcceptedLabelers } from "../labels/select";
import { resolveActor } from "../identity";
import { getStatusOverview, registerCursorRoute } from "./diagnostics";
import { registerCollectionRoutes } from "./collection";
import { registerFeedRoutes } from "./feed";
import { registerNotifyRoute } from "./notify";
import { resolveProfiles } from "./profiles";
import { createServiceAuthGate } from "../service-auth";
import {
  describePublicService,
  hostsServiceDidDocument,
  normalizeLexiconDocuments,
  normalizePublicServiceEndpoint,
  validatePublicServiceAuthEndpoint,
  validatePublicServiceLexicons,
  type PublicServiceOptions,
} from "../../public-service";

export interface CreateAppOptions {
  /** Lexicon JSON documents to expose from the deployment. */
  lexicons?: object[];
  /** Enable stable discovery for anonymous read-through clients. */
  publicService?: PublicServiceOptions;
}

export function createApp(
  db: Database,
  config: ContrailConfig,
  options: CreateAppOptions = {},
): Hono {
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
    const overview = await getStatusOverview(db, config);
    if (!options.publicService) return c.json(overview);
    c.header("cache-control", "public, max-age=15, stale-while-revalidate=45");
    const hasRequiredDelivery = Object.values(
      config.changes?.consumers ?? {},
    ).some((consumer) => consumer.requiredForActivation === true);
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
      ...(hasRequiredDelivery
        ? { required_delivery: overview.delivery.required }
        : {}),
    });
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/xrpc/_health", (c) => c.json({ status: "ok" }));

  const ns = config.namespace;
  const lexicons = options.publicService
    ? normalizeLexiconDocuments(options.lexicons ?? [])
    : (options.lexicons ?? []);
  if (options.publicService) {
    const publicEndpoint = normalizePublicServiceEndpoint(
      options.publicService.endpoint,
      options.publicService,
    );
    validatePublicServiceLexicons(config, lexicons);
    validatePublicServiceAuthEndpoint(config, options.publicService);
    const description = describePublicService(
      config,
      options.publicService,
      lexicons,
    );
    app.get("/.well-known/contrail", async (c) => {
      const { manifest } = await description;
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
      const service = await description;
      c.header("content-type", "application/json; charset=UTF-8");
      c.header("cache-control", "no-cache");
      c.header("etag", `\"${service.manifest.lexicons.digest}\"`);
      return c.body(service.canonicalLexicons);
    });
    app.get("/lexicons/:digest", async (c) => {
      const service = await description;
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
    const actor = c.req.query("actor");
    if (!actor) return c.json({ error: "actor parameter required" }, 400);

    const did = await resolveActor(db, actor, config);
    if (!did) return c.json({ error: "Could not resolve actor" }, 400);

    for (const profile of (config.profiles ?? []).map(normalizeProfileConfig)) {
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
        const labelsByUri = await hydrateLabels(db, [did], selection.accepted);
        const labels = labelsByUri[did];
        if (labels && labels.length > 0) {
          for (const profile of profiles) profile.labels = labels;
        }
        c.header("atproto-content-labelers", selection.accepted.join(","));
      }
    }

    return c.json({ profiles });
  });

  registerCursorRoute(app, db, config);
  registerCollectionRoutes(app, db, config);
  registerFeedRoutes(app, db, config, serviceAuth);
  registerNotifyRoute(app, db, config, serviceAuth);

  return app;
}
