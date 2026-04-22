/** Decorator that wraps a spaces StorageAdapter and publishes realtime events
 *  after successful writes. Spaces and community modules stay unaware of
 *  realtime; the decorator is the only integration seam. */

import type { StorageAdapter, SpaceMemberRow } from "../spaces/types";
import type { PubSub, RealtimeEvent } from "./types";
import { communityTopic, spaceTopic } from "./types";

export interface PublishingAdapterOptions {
  /** Optional lookup: given a space's ownerDid, return true if that DID is a
   *  community in the local `communities` table. When provided, writes also
   *  publish to `community:<ownerDid>` so subscribers who expanded that alias
   *  at ticket-mint time receive the event.
   *
   *  The lookup is expected to be cheap (cached in the caller) — the decorator
   *  calls it on every write. */
  isCommunityDid?: (did: string) => Promise<boolean> | boolean;
}

export function wrapWithPublishing(
  inner: StorageAdapter,
  pubsub: PubSub,
  opts: PublishingAdapterOptions = {}
): StorageAdapter {
  const publishSpaceAndCommunity = async (
    spaceUri: string,
    ownerDid: string | null,
    build: (topic: string) => RealtimeEvent
  ): Promise<void> => {
    await pubsub.publish(build(spaceTopic(spaceUri)));
    if (ownerDid && opts.isCommunityDid && (await opts.isCommunityDid(ownerDid))) {
      await pubsub.publish(build(communityTopic(ownerDid)));
    }
  };

  const ownerOf = async (spaceUri: string): Promise<string | null> => {
    const s = await inner.getSpace(spaceUri);
    return s?.ownerDid ?? null;
  };

  const wrapped: StorageAdapter = {
    ...inner,
    createSpace: inner.createSpace.bind(inner),
    getSpace: inner.getSpace.bind(inner),
    listSpaces: inner.listSpaces.bind(inner),
    deleteSpace: inner.deleteSpace.bind(inner),
    updateSpaceAppPolicy: inner.updateSpaceAppPolicy.bind(inner),
    getMember: inner.getMember.bind(inner),
    listMembers: inner.listMembers.bind(inner),
    createInvite: inner.createInvite.bind(inner),
    listInvites: inner.listInvites.bind(inner),
    revokeInvite: inner.revokeInvite.bind(inner),
    getInvite: inner.getInvite.bind(inner),
    redeemInvite: inner.redeemInvite.bind(inner),
    getRecord: inner.getRecord.bind(inner),
    listRecords: inner.listRecords.bind(inner),
    listCollections: inner.listCollections.bind(inner),
    putBlobMeta: inner.putBlobMeta.bind(inner),
    getBlobMeta: inner.getBlobMeta.bind(inner),
    listBlobMeta: inner.listBlobMeta.bind(inner),
    deleteBlobMeta: inner.deleteBlobMeta.bind(inner),
    findOrphanBlobs: inner.findOrphanBlobs.bind(inner),

    async addMember(spaceUri, did, addedBy) {
      await inner.addMember(spaceUri, did, addedBy);
      const owner = await ownerOf(spaceUri);
      const now = Date.now();
      await publishSpaceAndCommunity(spaceUri, owner, (topic) => ({
        topic,
        kind: "member.added",
        payload: { spaceUri, did },
        ts: now,
      }));
    },

    async removeMember(spaceUri, did) {
      await inner.removeMember(spaceUri, did);
      const owner = await ownerOf(spaceUri);
      const now = Date.now();
      await publishSpaceAndCommunity(spaceUri, owner, (topic) => ({
        topic,
        kind: "member.removed",
        payload: { spaceUri, did },
        ts: now,
      }));
    },

    async applyMembershipDiff(spaceUri, adds, removes, addedBy) {
      await inner.applyMembershipDiff(spaceUri, adds, removes, addedBy);
      if (adds.length === 0 && removes.length === 0) return;
      const owner = await ownerOf(spaceUri);
      const now = Date.now();
      for (const did of adds) {
        await publishSpaceAndCommunity(spaceUri, owner, (topic) => ({
          topic,
          kind: "member.added",
          payload: { spaceUri, did },
          ts: now,
        }));
      }
      for (const did of removes) {
        await publishSpaceAndCommunity(spaceUri, owner, (topic) => ({
          topic,
          kind: "member.removed",
          payload: { spaceUri, did },
          ts: now,
        }));
      }
    },

    async putRecord(record) {
      await inner.putRecord(record);
      const owner = await ownerOf(record.spaceUri);
      const now = Date.now();
      await publishSpaceAndCommunity(record.spaceUri, owner, (topic) => ({
        topic,
        kind: "record.created",
        payload: {
          spaceUri: record.spaceUri,
          collection: record.collection,
          authorDid: record.authorDid,
          rkey: record.rkey,
          cid: record.cid,
          record: record.record,
          createdAt: record.createdAt,
        },
        ts: now,
      }));
    },

    async deleteRecord(spaceUri, collection, authorDid, rkey) {
      await inner.deleteRecord(spaceUri, collection, authorDid, rkey);
      const owner = await ownerOf(spaceUri);
      const now = Date.now();
      await publishSpaceAndCommunity(spaceUri, owner, (topic) => ({
        topic,
        kind: "record.deleted",
        payload: { spaceUri, collection, authorDid, rkey },
        ts: now,
      }));
    },
  };
  return wrapped;
}

// Keep this import hint for types that downstream code might pull from here.
export type { SpaceMemberRow };
