import type { AuthenticatedPdsSession } from "@atmo-dev/contrail-spaces-alpha/consumer";
import type { IntegratedSpacesRuntime } from "@atmo-dev/contrail-spaces-alpha/worker";

declare global {
  namespace App {
    interface Locals {
      session: AuthenticatedPdsSession | null;
      did: string | null;
    }
    interface Platform {
      env: {
        OAUTH_SESSIONS: KVNamespace;
        OAUTH_STATES: KVNamespace;
        OAUTH_PUBLIC_URL: string;
        COOKIE_SECRET: string;
        CLIENT_ASSERTION_KEY: string;
        DB: D1Database;
        SPACES_QUEUE: Queue;
        SPACES_CREDENTIAL_ENCRYPTION_KEY: string;
        SPACE_SUBSCRIPTIONS: DurableObjectNamespace;
        SPACES_RUNTIME: IntegratedSpacesRuntime;
      };
      context: ExecutionContext;
      caches: CacheStorage;
    }
  }
}

export {};
