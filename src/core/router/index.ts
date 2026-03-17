import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database, ContrailConfig } from "../types";
import { registerAdminRoutes } from "./admin";
import { registerCollectionRoutes } from "./collection";
import { resolveActor } from "../identity";
import { resolveProfiles } from "./profiles";
import { backfillUser } from "../backfill";

export function createApp(
  db: Database,
  config: ContrailConfig,
  adminSecret?: string
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
    const profiles = config.profiles ?? ["app.bsky.actor.profile"];
    for (const collection of profiles) {
      await backfillUser(db, did, collection, Date.now() + 10_000, config);
    }

    const profileMap = await resolveProfiles(db, config, [did]);
    const profile = profileMap[did];
    if (!profile) return c.json({ error: "Profile not found" }, 404);

    return c.json(profile);
  });

  registerAdminRoutes(app, db, config, adminSecret);
  registerCollectionRoutes(app, db, config);

  return app;
}
