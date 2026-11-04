import type { OAuthSession } from '@atcute/oauth-node-client';

declare global {
  namespace App {
    interface Locals { session: OAuthSession | null }
  }
}
export {};
