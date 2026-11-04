import { InvitationError } from '@atmo-dev/contrail-spaces-alpha/invitations';
import { PdsRequestError } from '@atmo-dev/contrail-spaces-alpha/consumer';

export class InputError extends Error {}

/** Never forward upstream bodies, tokens or invitation data to browser errors. */
export function messageFor(error: unknown): string {
  if (error instanceof InputError || error instanceof InvitationError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'PolicyNotPublished') return 'This event space needs a published policy.';
  if (code === 'PolicyMismatch') return 'This space does not support event membership.';
  if (code === 'PolicyVerificationFailed') return 'Could not verify the space. Check that the account has a published KEM key.';
  if (code === 'SpaceNotFound' || code === 'Forbidden' || code === 'SpaceUnavailable') return 'Event unavailable or access denied.';
  if (error instanceof PdsRequestError && ['InvalidRequest', 'MethodNotImplemented', 'XRPCNotSupported'].includes(error.code)) return 'Use an account on a PDS running the current Spaces alpha.';
  return 'Could not complete the request. Please try again.';
}
