import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContrailConfig, Database } from "../types";
import { normalizeProfileConfig } from "../types";
import { backfillUser } from "../backfill";
import { hydrateLabels } from "../labels/hydrate";
import { selectAcceptedLabelers } from "../labels/select";
import { resolveActor } from "../identity";
import { getOverview, registerAdminRoutes } from "./admin";
import { registerCollectionRoutes } from "./collection";
import { registerFeedRoutes } from "./feed";
import { registerNotifyRoute } from "./notify";
import { resolveProfiles } from "./profiles";

export interface CreateAppOptions {
  /** Lexicon JSON documents to expose from the deployment. */
  lexicons?: object[];
}

export function createApp(
  db: Database,
  config: ContrailConfig,
  options: CreateAppOptions = {},
): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) => c.json({ status: "ok" }));
  app.get("/status", async (c) => c.json(await getOverview(db, config)));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/xrpc/_health", (c) => c.json({ status: "ok" }));

  const ns = config.namespace;
  if (options.lexicons && options.lexicons.length > 0) {
    const lexicons = options.lexicons;
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

  registerAdminRoutes(app, db, config);
  registerCollectionRoutes(app, db, config);
  registerFeedRoutes(app, db, config);
  registerNotifyRoute(app, db, config);

  return app;
}
