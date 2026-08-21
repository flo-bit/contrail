import { env } from "$env/dynamic/private";
import { createAtprotoAuth } from "@svelte-atproto/oauth/server";
import { cloudflareKV } from "@svelte-atproto/oauth/server/stores/cloudflare";
import { spacesConsumerOAuthScopes } from "@atmo-dev/contrail-spaces-alpha/consumer";
import {
  COLLECTIONS,
  PROVIDER_AUDIENCE,
  SPACE_SKEY,
  SPACE_TYPE,
} from "$lib/constants";

export const atproto = createAtprotoAuth({
  origin: env.OAUTH_PUBLIC_URL,
  cookieSecret: env.COOKIE_SECRET,
  clientAssertionKey: env.CLIENT_ASSERTION_KEY,
  scope: spacesConsumerOAuthScopes({
    audience: PROVIDER_AUDIENCE,
    namespace: SPACE_TYPE,
    collections: COLLECTIONS,
    spaceType: SPACE_TYPE,
    skey: SPACE_SKEY,
  }),
  sessions: cloudflareKV("OAUTH_SESSIONS"),
  states: cloudflareKV("OAUTH_STATES", { ttl: 600 }),
});
