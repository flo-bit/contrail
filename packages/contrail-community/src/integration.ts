/** Factory that builds a {@link CommunityIntegration} for contrail's
 *  `createApp({ community })` option. The integration is opaque to contrail
 *  core — it just exposes the hooks the umbrella router needs. */

import type {
  CommunityIntegration,
  CommunityProbe,
  ContrailConfig,
  Database,
  StorageAdapter,
} from "@atmo-dev/contrail";
import { HostedAdapter, buildVerifier, createServiceAuthMiddleware } from "@atmo-dev/contrail";
import { CommunityAdapter } from "./adapter";
import { createCommunityWhoamiExtension } from "./whoami";
import { createCommunityInviteHandler } from "./invite-handler";
import { resolveReachableSpaces } from "./acl";
import { registerCommunityRoutes } from "./router";
import { buildCommunitySchema } from "./schema";
import { getDialect } from "@atmo-dev/contrail";

export interface CommunityIntegrationOptions {
  /** Database the community tables live in. Should be the same DB the
   *  spaces module uses (community rows reference space_uri). */
  db: Database;
  /** Resolved contrail config. */
  config: ContrailConfig;
  /** Optional override of the community adapter (for tests). */
  communityAdapter?: CommunityAdapter;
  /** Optional override of the spaces adapter (for tests). Otherwise built
   *  from the same db using HostedAdapter. */
  spacesAdapter?: StorageAdapter;
}

export function createCommunityIntegration(
  options: CommunityIntegrationOptions
): CommunityIntegration {
  const { db, config } = options;
  const community = options.communityAdapter ?? new CommunityAdapter(db);
  const spaces = options.spacesAdapter ?? new HostedAdapter(db, config);

  const probe: CommunityProbe = {
    async getCommunity(did) {
      return community.getCommunity(did);
    },
    async resolveReachableSpaces(callerDid) {
      return resolveReachableSpaces(community, callerDid);
    },
  };

  const whoamiExtension = createCommunityWhoamiExtension({ community });
  const inviteHandler = createCommunityInviteHandler({
    community,
    authority: spaces,
  });

  return {
    probe,
    whoamiExtension,
    inviteHandler,
    registerRoutes(app, opts) {
      // Reuse the spaces JWT verifier — the auth model is identical.
      if (!config.spaces?.authority) return;
      const verifier = buildVerifier(config.spaces.authority);
      const authMiddleware =
        opts?.authMiddleware ?? createServiceAuthMiddleware(verifier);
      registerCommunityRoutes(
        app,
        db,
        config,
        { authMiddleware, communityAdapter: community, spacesAdapter: spaces },
        { spacesAdapter: spaces, verifier }
      );
    },
    async applySchema(target) {
      const dialect = getDialect(target);
      const stmts = buildCommunitySchema(dialect);
      await target.batch(stmts.map((s) => target.prepare(s)));
    },
  };
}
