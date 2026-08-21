import type { AuthenticatedPdsSession } from "@atmo-dev/contrail-spaces-alpha/consumer";

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
      };
      context: ExecutionContext;
      caches: CacheStorage;
    }
  }
}

export {};
