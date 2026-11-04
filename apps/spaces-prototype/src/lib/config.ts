export const ORIGIN = 'http://127.0.0.1:5177';
// Test-only application NSIDs. Do not publish these Lexicons; use a namespace
// you control before turning this local prototype into a public application.
export const SPACE_TYPE = 'dev.contrail.prototype.eventSpace';
export const CONTROL_TYPE = 'dev.contrail.prototype.invitations';
export const INVITATION_COLLECTION = 'dev.contrail.prototype.invitation';
export const EVENT_COLLECTION = 'community.lexicon.calendar.event';
export const RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

export type RsvpStatus = 'going' | 'notgoing';
export interface EventRecord {
  $type: typeof EVENT_COLLECTION;
  name: string;
  description?: string;
  startsAt?: string;
  createdAt: string;
}
export interface RsvpRecord {
  $type: typeof RSVP_COLLECTION;
  subject: { uri: string; cid: string };
  status: string;
}
export interface RecordView<T> {
  uri: string;
  cid: string;
  did: string;
  value: T;
}
