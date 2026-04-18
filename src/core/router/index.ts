import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database, ContrailConfig } from "../types";
import { normalizeProfileConfig } from "../types";
import { registerAdminRoutes } from "./admin";
import { registerCollectionRoutes } from "./collection";
import { registerFeedRoutes } from "./feed";
import { registerNotifyRoute } from "./notify";
import { registerSpacesRoutes } from "../spaces/router";
import type { SpacesRoutesOptions } from "../spaces/router";
import { buildVerifier } from "../spaces/auth";
import { HostedAdapter } from "../spaces/adapter";
import type { StorageAdapter } from "../spaces/types";
import type { ServiceJwtVerifier } from "@atcute/xrpc-server/auth";
import { resolveActor } from "../identity";
import { resolveProfiles } from "./profiles";
import { backfillUser } from "../backfill";

export interface SpacesContext {
  adapter: StorageAdapter;
  verifier: ServiceJwtVerifier;
}

export interface CreateAppOptions {
  spaces?: SpacesRoutesOptions;
  /** Separate DB for the spaces tables. Defaults to `db`. */
  spacesDb?: Database;
  /** Full spaces context override (escape hatch for tests). */
  spacesCtx?: SpacesContext | null;
}

export function createApp(
  db: Database,
  config: ContrailConfig,
  options: CreateAppOptions = {}
): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) => c.json({ status: "ok" }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/xrpc/_health", (c) => c.json({ status: "ok" }));

  const ns = config.namespace;

  app.get(`/xrpc/${ns}.getProfile`, async (c) => {
    const actor = c.req.query("actor");
    if (!actor) return c.json({ error: "actor parameter required" }, 400);

    const did = await resolveActor(db, actor);
    if (!did) return c.json({ error: "Could not resolve actor" }, 400);

    // Ensure profile records are backfilled
    const profileConfigs = (config.profiles ?? []).map(normalizeProfileConfig);
    for (const pc of profileConfigs) {
      await backfillUser(db, did, pc.collection, Date.now() + 3_000, config, {
        maxRetries: 0,
        requestTimeout: 3_000,
      });
    }

    const profileMap = await resolveProfiles(db, config, [did]);
    const profiles = profileMap[did];
    if (!profiles || profiles.length === 0) return c.json({ error: "Profile not found" }, 404);

    return c.json({ profiles });
  });

  // Shared spaces context — verifier + adapter — reused by both the per-collection
  // routes (for `?spaceUri=...` dispatch) and the `<ns>.space.*` routes.
  const spacesDb = options.spacesDb ?? db;
  const spacesCtx: SpacesContext | null =
    options.spacesCtx !== undefined
      ? options.spacesCtx
      : config.spaces
        ? {
            adapter: options.spaces?.adapter ?? new HostedAdapter(spacesDb, config),
            verifier: buildVerifier(config.spaces),
          }
        : null;

  registerAdminRoutes(app, db, config);
  registerCollectionRoutes(app, db, config, spacesCtx);
  registerFeedRoutes(app, db, config);
  registerNotifyRoute(app, db, config);
  registerSpacesRoutes(app, spacesDb, config, options.spaces, spacesCtx);

  return app;
}
