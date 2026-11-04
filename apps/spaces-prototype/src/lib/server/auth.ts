import {
  OAuthClient, MemoryStore, type OAuthSession, type StoredSession, type StoredState,
  TokenInvalidError, TokenRevokedError, AuthMethodUnsatisfiableError,
} from '@atcute/oauth-node-client';
import {
  LocalActorResolver, CompositeHandleResolver, DohJsonHandleResolver, WellKnownHandleResolver,
  CompositeDidDocumentResolver, PlcDidDocumentResolver, WebDidDocumentResolver,
} from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons';
import { formatSpacePermissionScope } from '@atmo-dev/contrail-spaces-alpha/consumer';
import { CONTROL_TYPE, EVENT_COLLECTION, INVITATION_COLLECTION, ORIGIN, RSVP_COLLECTION, SPACE_TYPE } from '../config';
import { EphemeralStore } from './state';

export const browserSessions = new EphemeralStore<Did>(14 * 24 * 60 * 60_000);
export const SESSION_COOKIE = 'prototype_session';
export const FLOW_COOKIE = 'prototype_oauth';
export const PENDING_COOKIE = 'prototype_invite';
export const cookieOptions = { path: '/', httpOnly: true, secure: false, sameSite: 'lax' as const };
let client: OAuthClient | undefined;

export function getOAuth(): OAuthClient {
  if (!client) client = new OAuthClient({
    metadata: {
      redirect_uris: [`${ORIGIN}/oauth/callback`],
      scope: [
        'atproto',
        formatSpacePermissionScope({ type: SPACE_TYPE, collections: [EVENT_COLLECTION, RSVP_COLLECTION] }),
        formatSpacePermissionScope({ type: CONTROL_TYPE, authority: '*', skey: 'self',
          collections: [INVITATION_COLLECTION], actions: ['read_self', 'create', 'update', 'delete'], manage: ['create'] }),
      ],
    },
    actorResolver: new LocalActorResolver({
      handleResolver: new CompositeHandleResolver({ methods: {
        dns: new DohJsonHandleResolver({ dohUrl: 'https://mozilla.cloudflare-dns.com/dns-query' }),
        http: new WellKnownHandleResolver(),
      } }),
      didDocumentResolver: new CompositeDidDocumentResolver({ methods: {
        plc: new PlcDidDocumentResolver(), web: new WebDidDocumentResolver(),
      } }),
    }),
    stores: {
      sessions: new MemoryStore<Did, StoredSession>(),
      states: new MemoryStore<string, StoredState>({ ttl: 600_000 }),
    },
    // The SDK's default in-memory refresh lock is shared by this one client.
    // Both browser requests and offline invitation acceptance use this instance.
  });
  return client;
}

export async function restoreBrowserSession(key: string | undefined): Promise<OAuthSession | null> {
  const did = browserSessions.get(key);
  if (!did) return null;
  try { return await getOAuth().restore(did); }
  catch (error) {
    if (error instanceof TokenInvalidError || error instanceof TokenRevokedError || error instanceof AuthMethodUnsatisfiableError) {
      browserSessions.delete(key);
      return null;
    }
    throw error; // Don't silently sign people out on a transient failure.
  }
}
