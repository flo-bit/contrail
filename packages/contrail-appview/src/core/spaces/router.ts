/** Umbrella that wires the authority + record-host route registrations from
 *  their respective packages onto a single Hono app. The actual route
 *  handlers live in `@atmo-dev/contrail-authority` and
 *  `@atmo-dev/contrail-record-host`. */

import type { Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig, Database } from "../types";
import { HostedAdapter } from "./adapter";
import {
  buildVerifier,
  createBindingCredentialVerifier,
  createCompositeBindingResolver,
  createEnrollmentBindingResolver,
  createLocalBindingResolver,
  createLocalKeyResolver,
  createServiceAuthMiddleware,
} from "@atmo-dev/contrail-base";
import type {
  CredentialVerifier,
  StorageAdapter,
  WhoamiExtension,
} from "@atmo-dev/contrail-base";
import { registerAuthorityRoutes } from "@atmo-dev/contrail-authority";
import { registerRecordHostRoutes } from "@atmo-dev/contrail-record-host";

// Re-export the route-registration functions and WhoamiExtension type so
// existing consumers of `@atmo-dev/contrail` keep their imports working
// without switching to the new packages.
export { registerAuthorityRoutes, registerRecordHostRoutes };
export type { WhoamiExtension };

export interface SpacesRoutesOptions {
  /** Provide a custom middleware (e.g. for tests). If omitted and authority is set, a real one is built. */
  authMiddleware?: MiddlewareHandler;
  /** Storage adapter override. Defaults to HostedAdapter(db). */
  adapter?: StorageAdapter;
  /** Optional whoami extension; see {@link WhoamiExtension}. */
  whoamiExtension?: WhoamiExtension;
  /** Optional credential verifier for the record host. */
  credentialVerifier?: CredentialVerifier;
}

/** Umbrella registration: wires both the authority and the record-host
 *  routes against the same adapter. Today's deployments enable both via
 *  `config.spaces.authority` and `config.spaces.recordHost`. */
export function registerSpacesRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  options: SpacesRoutesOptions = {},
  ctx?: { adapter: StorageAdapter; verifier: import("@atcute/xrpc-server/auth").ServiceJwtVerifier } | null
): void {
  const spacesConfig = config.spaces;
  if (!spacesConfig) return;
  const authorityConfig = spacesConfig.authority;
  if (!authorityConfig) return;

  const adapter = options.adapter ?? ctx?.adapter ?? new HostedAdapter(db, config);
  const verifier = ctx?.verifier ?? buildVerifier(authorityConfig);
  const auth = options.authMiddleware ?? createServiceAuthMiddleware(verifier);

  const localRecordHost = spacesConfig.recordHost ? adapter : null;
  registerAuthorityRoutes(
    app,
    adapter,
    authorityConfig,
    config,
    auth,
    options.whoamiExtension,
    localRecordHost
  );

  if (spacesConfig.recordHost) {
    // Default in-process verifier: enrollment is the canonical binding
    // source; Local-binding is a fallback for spaces created but not yet
    // enrolled. Caller overrides via `options.credentialVerifier` to
    // accept external authorities.
    const credentialVerifier =
      options.credentialVerifier ??
      (authorityConfig.signing
        ? createBindingCredentialVerifier({
            bindings: createCompositeBindingResolver([
              createEnrollmentBindingResolver({ recordHost: adapter }),
              createLocalBindingResolver({ authorityDid: authorityConfig.serviceDid }),
            ]),
            keys: createLocalKeyResolver({
              authorityDid: authorityConfig.serviceDid,
              publicKey: authorityConfig.signing.publicKey,
            }),
          })
        : undefined);
    registerRecordHostRoutes(app, adapter, adapter, spacesConfig.recordHost, config, auth, credentialVerifier);
  }
}
