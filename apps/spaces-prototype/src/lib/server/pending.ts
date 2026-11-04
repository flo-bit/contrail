import type { InvitationLink } from '@atmo-dev/contrail-spaces-alpha/invitations';
import { EphemeralStore } from './state';

export const pendingInvites = new EphemeralStore<InvitationLink>(15 * 60_000);
export function matchingInvite(key: string | undefined, owner: string, rkey: string) {
  const link = pendingInvites.get(key);
  return link?.owner === owner && link.rkey === rkey ? link : undefined;
}
