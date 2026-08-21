import type { ContrailConfig } from "@atmo-dev/contrail";
import { createSpacesWorker } from "@atmo-dev/contrail-spaces-alpha/worker";
export { SpaceSubscriptionHub } from "@atmo-dev/contrail-spaces-alpha/worker";
import { authorityRecordMembership } from "@atmo-dev/contrail-spaces-alpha";
import {
  MEMBER_COLLECTION,
  NOTE_COLLECTION,
  PROVIDER_AUDIENCE,
  PROVIDER_ENDPOINT,
  REACTION_COLLECTION,
  SPACE_SKEY,
  SPACE_TYPE,
} from "./constants";
import { recordLexicons } from "./lexicons";

interface Env {
  [key: string]: unknown;
  DB: D1Database;
  SPACES_QUEUE: Queue;
  SPACES_CREDENTIAL_ENCRYPTION_KEY: string;
  SPACE_SUBSCRIPTIONS: DurableObjectNamespace;
}

const projection: ContrailConfig = {
  namespace: SPACE_TYPE,
  profiles: [],
  collections: {
    note: {
      collection: NOTE_COLLECTION,
      validate: true,
      searchable: ["text"],
      queryable: { createdAt: { type: "range" } },
      relations: {
        reactions: { collection: "reaction", field: "subject.uri" },
        replies: { collection: "note", field: "reply.uri" },
      },
      references: {
        reply: { collection: "note", field: "reply.uri" },
      },
    },
    member: {
      collection: MEMBER_COLLECTION,
      validate: true,
      queryable: { subject: {} },
    },
    reaction: {
      collection: REACTION_COLLECTION,
      validate: true,
      references: {
        note: { collection: "note", field: "subject.uri" },
      },
    },
  },
  validation: { verifyCid: true, strict: true },
  constellation: false,
};

export default createSpacesWorker<Env>({
  projection,
  lexicons: recordLexicons,
  service: {
    endpoint: PROVIDER_ENDPOINT,
    audience: PROVIDER_AUDIENCE,
  },
  spaceTypes: {
    [SPACE_TYPE]: {
      collections: [NOTE_COLLECTION, MEMBER_COLLECTION, REACTION_COLLECTION],
      access: authorityRecordMembership({
        collection: MEMBER_COLLECTION,
        principalField: "subject",
      }),
      skey: SPACE_SKEY,
    },
  },
  subscriptions: { binding: "SPACE_SUBSCRIPTIONS" },
  accessLeaseMs: 15 * 60_000,
  reconcileIntervalMs: 5 * 60_000,
});
