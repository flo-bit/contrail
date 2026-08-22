import { env } from "cloudflare:workers";
import { createAtprotoAuth } from "@svelte-atproto/oauth/server";
import { cloudflareKV } from "@svelte-atproto/oauth/server/stores/cloudflare";
import { spacesIntegratedOAuthScopes } from "@atmo-dev/contrail-spaces-alpha/consumer";
import {
  COLLECTIONS,
  SPACE_SKEY,
  SPACE_TYPE,
} from "$lib/constants";

const bindings = env as unknown as App.Platform["env"];
const oauthOrigin = new URL(bindings.OAUTH_PUBLIC_URL);
const localDevelopment = oauthOrigin.hostname === "localhost" ||
  oauthOrigin.hostname === "127.0.0.1" || oauthOrigin.hostname === "[::1]";

export const atproto = createAtprotoAuth({
  origin: localDevelopment ? undefined : oauthOrigin.href.replace(/\/$/, ""),
  dev: localDevelopment,
  devPort: Number(oauthOrigin.port || 5173),
  cookieSecret: bindings.COOKIE_SECRET,
  clientAssertionKey: bindings.CLIENT_ASSERTION_KEY,
  scope: spacesIntegratedOAuthScopes({
    collections: COLLECTIONS,
    spaceType: SPACE_TYPE,
    skey: SPACE_SKEY,
  }),
  sessions: cloudflareKV("OAUTH_SESSIONS"),
  states: cloudflareKV("OAUTH_STATES", { ttl: 600 }),
});
