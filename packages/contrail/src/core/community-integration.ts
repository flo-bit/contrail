/** Pluggable integration surface for the community module.
 *
 *  Phase 6 extracted community to its own package (`@atmo-dev/contrail-community`).
 *  The contrail core package never imports from it — couplings only flow
 *  through these interfaces. The community package's
 *  `createCommunityIntegration({ ... })` returns a {@link CommunityIntegration},
 *  which the consumer hands to `createApp` via `options.community`.
 *
 *  Two layers:
 *    - {@link CommunityProbe}: minimal "is this a community DID" / "what
 *      spaces does this caller reach" surface used by realtime + collection
 *      routes for community-aware dispatch.
 *    - {@link CommunityIntegration}: the umbrella bundle — probe, whoami
 *      extension, invite handler, plus route + schema wiring that the
 *      umbrella router calls during setup. */

import type { Hono, MiddlewareHandler } from "hono";
import type { Database } from "./types";
import type { CommunityInviteHandler } from "./invite/community-handler";
import type { WhoamiExtension } from "./spaces/router";

/** Narrow interface for the deep callers (realtime/resolve, router/collection)
 *  that just need to ask "is this a community DID?" or "what spaces does this
 *  caller reach via community membership?" */
export interface CommunityProbe {
  /** Look up a community row by DID. Returns null for non-community DIDs.
   *  Callers usually only check truthiness — community-specific fields stay
   *  inside the community package. */
  getCommunity(did: string): Promise<{ did: string } | null>;

  /** Resolve the set of space URIs reachable by `callerDid` through community
   *  membership (direct grants + delegations). Used by realtime to expand
   *  community: topics into the caller's concrete space: topics. */
  resolveReachableSpaces(callerDid: string): Promise<Set<string>>;
}

/** Umbrella integration the consumer constructs once and hands to createApp.
 *  contrail core treats this as an opaque bundle — it doesn't introspect
 *  community state, just calls these methods at the right wiring points. */
export interface CommunityIntegration {
  /** Probe used by realtime + collection cross-cutting concerns. */
  probe: CommunityProbe;
  /** Whoami extension that returns `accessLevel` for community-owned spaces. */
  whoamiExtension: WhoamiExtension;
  /** Handler for the community-grant path of the unified invite surface. */
  inviteHandler: CommunityInviteHandler;
  /** Register `<ns>.community.*` routes onto the Hono app. */
  registerRoutes(
    app: Hono,
    options?: { authMiddleware?: MiddlewareHandler }
  ): void;
  /** Apply community schema (DDL) to the database. Called by initSchema. */
  applySchema(db: Database): Promise<void>;
}
