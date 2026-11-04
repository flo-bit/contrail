import { describe, expect, it, vi } from 'vitest';
import { EphemeralStore, safeReturnTo } from '../src/lib/server/state';
import { matchingInvite, pendingInvites } from '../src/lib/server/pending';
import { getOAuth } from '../src/lib/server/auth';
import { getServices } from '../src/lib/server/prototype';
import { eventAddress } from '../src/lib/server/events';
import { ORIGIN, CONTROL_TYPE, EVENT_COLLECTION, RSVP_COLLECTION, SPACE_TYPE } from '../src/lib/config';

describe('ephemeral browser state', () => {
  it('uses opaque keys and expires values without exposing them in cookies', () => {
    let now = 0;
    const store = new EphemeralStore<{ secret: string }>(100, () => now);
    const key = store.put({ secret: 'never-a-cookie' });
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.get(key)).toEqual({ secret: 'never-a-cookie' });
    now = 100;
    expect(store.get(key)).toBeUndefined();
  });
  it('binds pending invitations to the exact route and supports deletion', () => {
    const key = pendingInvites.put({ owner: 'did:plc:alice', rkey: 'invite', secret: 'test' });
    expect(matchingInvite(key, 'did:plc:alice', 'invite')).toBeDefined();
    expect(matchingInvite(key, 'did:plc:mallory', 'invite')).toBeUndefined();
    expect(matchingInvite(key, 'did:plc:alice', 'different')).toBeUndefined();
    pendingInvites.delete(key);
    expect(matchingInvite(key, 'did:plc:alice', 'invite')).toBeUndefined();
  });
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/invite/owner/key#secret', '/invite/owner/key?secret=x', '/login', null])('refuses unsafe return paths: %s', (path) => {
    expect(safeReturnTo(path)).toBe('/');
  });
  it('preserves a local event or invitation route', () => {
    expect(safeReturnTo('/invite/did%3Aplc%3Aalice/key')).toBe('/invite/did%3Aplc%3Aalice/key');
  });
});

describe('local runtime setup', () => {
  it('constructs the real worker integration without contacting a PDS', () => {
    expect(typeof getServices().readEvent).toBe('function');
    expect(typeof getServices().invitations.preview).toBe('function');
  });
  it('initializes real SQLite/validation and declines a malformed delegation before any external request', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden in this test'));
    try {
      const session = { did: 'did:plc:alice', handle: vi.fn(async () => Response.json({ token: 'malformed' })) };
      await expect(getServices().readEvent(session, eventAddress(session.did, '3h4oqw2vvxpwz'))).rejects.toThrow('Expected a compact JWT');
      expect(session.handle).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('uses loopback public-client OAuth with the required scoped Spaces grants', () => {
    const oauth = getOAuth();
    expect(oauth.metadata.redirect_uris).toEqual([`${ORIGIN}/oauth/callback`]);
    expect(oauth.metadata.client_id).toMatch(/^http:\/\/localhost\?/);
    expect(oauth.metadata.scope).toContain(`space:${SPACE_TYPE}?`);
    expect(oauth.metadata.scope).toContain(EVENT_COLLECTION);
    expect(oauth.metadata.scope).toContain(RSVP_COLLECTION);
    expect(oauth.metadata.scope).toContain(`space:${CONTROL_TYPE}?`);
    expect(oauth.metadata.scope).toContain('read_self');
    expect(oauth.metadata.scope).not.toContain('repo:');
  });
});
