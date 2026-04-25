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
import { buildVerifier, createServiceAuthMiddleware } from "../spaces/auth";
import { HostedAdapter } from "../spaces/adapter";
import type { StorageAdapter } from "../spaces/types";
import type { ServiceJwtVerifier } from "@atcute/xrpc-server/auth";
import { registerCommunityRoutes } from "../community/router";
import type { CommunityRoutesOptions } from "../community/router";
import { CommunityAdapter } from "../community/adapter";
import { registerRealtimeRoutes } from "../realtime/router";
import type { RealtimeRoutesOptions } from "../realtime/router";
import { registerInviteRoutes } from "../invite/router";
import { InMemoryPubSub } from "../realtime/in-memory";
import { wrapWithPublishing } from "../realtime/publishing-adapter";
import type { PubSub } from "../realtime/types";
import { resolveActor } from "../identity";
import { resolveProfiles } from "./profiles";
import { backfillUser } from "../backfill";
import { selectAcceptedLabelers } from "../labels/select";
import { hydrateLabels } from "../labels/hydrate";

export interface SpacesContext {
  adapter: StorageAdapter;
  verifier: ServiceJwtVerifier;
}

export interface CreateAppOptions {
  spaces?: SpacesRoutesOptions;
  community?: CommunityRoutesOptions;
  realtime?: Partial<RealtimeRoutesOptions>;
  /** Separate DB for the spaces tables. Defaults to `db`. */
  spacesDb?: Database;
  /** Full spaces context override (escape hatch for tests). */
  spacesCtx?: SpacesContext | null;
  /** Lexicon JSONs to serve at `/lexicons` so consumer apps can fetch +
   *  typegen against this deployment. Emit with `contrail-lex generate` —
   *  its `lexicons/generated/index.ts` exports the right shape. If omitted,
   *  the endpoint returns `404`. */
  lexicons?: object[];
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

  // Lexicon manifest — lets consumer apps fetch every lexicon this
  // deployment speaks (generated + pulled + custom) over HTTP and
  // typegen clients, without needing a PDS or DNS resolution. Only
  // registered when the caller passed bundled lexicons at build time
  // via `contrail-lex generate`.
  if (options.lexicons && options.lexicons.length > 0) {
    const lexicons = options.lexicons;
    app.get(`/xrpc/${ns}.lexicons`, (c) => c.json({ lexicons }));
  }

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

    if (config.labels) {
      const params = new URL(c.req.url).searchParams;
      const sel = selectAcceptedLabelers(
        c.req.raw.headers.get("atproto-accept-labelers"),
        params.get("labelers"),
        config.labels,
      );
      if (sel.accepted.length > 0) {
        const labelsByUri = await hydrateLabels(db, [did], sel.accepted);
        const ls = labelsByUri[did];
        if (ls && ls.length > 0) {
          for (const entry of profiles) {
            entry.labels = ls;
          }
        }
        c.header("atproto-content-labelers", sel.accepted.join(","));
      }
    }

    return c.json({ profiles });
  });

  // Shared spaces context — verifier + adapter — reused by both the per-collection
  // routes (for `?spaceUri=...` dispatch) and the `<ns>.space.*` routes.
  const spacesDb = options.spacesDb ?? db;
  let spacesCtx: SpacesContext | null =
    options.spacesCtx !== undefined
      ? options.spacesCtx
      : config.spaces
        ? {
            adapter: options.spaces?.adapter ?? new HostedAdapter(spacesDb, config),
            verifier: buildVerifier(config.spaces),
          }
        : null;

  // Realtime pubsub is built whenever realtime is configured — independent of
  // spaces. With spaces, the spaces adapter is wrapped so private record/member
  // events publish to space:/community: topics. Without spaces, only public
  // topics (collection:/actor:) see traffic — those are published from
  // applyEvents (jetstream ingestion), not from here.
  let realtimePubsub: PubSub | null = null;
  if (config.realtime) {
    realtimePubsub =
      options.realtime?.pubsub ?? config.realtime.pubsub ?? new InMemoryPubSub({
        queueBound: config.realtime.queueBound,
      });
    if (spacesCtx) {
      const communityAdapter = config.community ? new CommunityAdapter(spacesDb) : null;
      const isCommunityDid = communityAdapter
        ? cachedIsCommunityDid(communityAdapter)
        : undefined;
      spacesCtx = {
        ...spacesCtx,
        adapter: wrapWithPublishing(spacesCtx.adapter, realtimePubsub, { isCommunityDid }),
      };
    }
  }

  registerAdminRoutes(app, db, config);
  const communityAdapterForCollection = config.community
    ? new CommunityAdapter(spacesDb)
    : null;
  registerCollectionRoutes(app, db, config, spacesCtx, {
    pubsub: realtimePubsub,
    community: communityAdapterForCollection,
  });
  registerFeedRoutes(app, db, config);
  registerNotifyRoute(app, db, config);
  const communityAdapterForSpaces = config.community && spacesCtx
    ? new CommunityAdapter(spacesDb)
    : null;
  registerSpacesRoutes(app, spacesDb, config, options.spaces, spacesCtx, communityAdapterForSpaces);

  if (config.community && spacesCtx) {
    // Community routes reuse the spaces service-auth middleware (same JWT verifier).
    const authMiddleware =
      options.community?.authMiddleware ??
      options.spaces?.authMiddleware ??
      createServiceAuthMiddleware(spacesCtx.verifier);
    registerCommunityRoutes(
      app,
      spacesDb,
      config,
      { ...options.community, authMiddleware },
      { spacesAdapter: spacesCtx.adapter, verifier: spacesCtx.verifier }
    );
  }

  if (config.spaces && spacesCtx) {
    // Unified invite surface: one `<ns>.invite.*` family that dispatches on
    // space ownership (user-owned → addMember; community-owned → grant).
    const authMiddleware =
      options.spaces?.authMiddleware ??
      createServiceAuthMiddleware(spacesCtx.verifier);
    const communityAdapter = config.community ? new CommunityAdapter(spacesDb) : null;
    registerInviteRoutes(app, config, spacesCtx.adapter, communityAdapter, { authMiddleware });
  }

  if (config.realtime && realtimePubsub) {
    // The ticket endpoint still needs a JWT verifier — but that verifier only
    // exists when spaces is configured. Without spaces, private-topic ticket
    // minting simply isn't offered; public subscriptions (collection:/actor:)
    // require no auth and still work.
    const authMiddleware = spacesCtx
      ? options.realtime?.authMiddleware ??
        options.spaces?.authMiddleware ??
        createServiceAuthMiddleware(spacesCtx.verifier)
      : null;
    const communityAdapter = config.community ? new CommunityAdapter(spacesDb) : null;
    registerRealtimeRoutes(app, config, spacesCtx?.adapter ?? null, communityAdapter, {
      authMiddleware,
      pubsub: realtimePubsub,
    });
  }

  return app;
}

function cachedIsCommunityDid(
  community: CommunityAdapter
): (did: string) => Promise<boolean> {
  const TTL = 60_000;
  const cache = new Map<string, { value: boolean; expires: number }>();
  return async (did: string) => {
    const now = Date.now();
    const hit = cache.get(did);
    if (hit && hit.expires > now) return hit.value;
    const row = await community.getCommunity(did);
    const value = row != null;
    cache.set(did, { value, expires: now + TTL });
    return value;
  };
}
