import type { ContrailConfig } from "@atmo-dev/contrail";
import { createSpacesWorker } from "@atmo-dev/contrail-spaces-alpha/worker";
import {
  NOTE_COLLECTION,
  PROVIDER_AUDIENCE,
  PROVIDER_ENDPOINT,
  REACTION_COLLECTION,
  SPACE_SKEY,
  SPACE_TYPE,
} from "$lib/constants";
import { recordLexicons } from "$lib/lexicons";

export interface SpacesDemoEnv {
  [key: string]: unknown;
  DB: D1Database;
  SPACES_QUEUE: Queue;
  SPACES_CREDENTIAL_ENCRYPTION_KEY: string;
  SPACE_SUBSCRIPTIONS: DurableObjectNamespace;
  OAUTH_PUBLIC_URL?: string;
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

export const spaces = createSpacesWorker<SpacesDemoEnv>({
  projection,
  lexicons: recordLexicons,
  service: {
    endpoint: PROVIDER_ENDPOINT,
    audience: PROVIDER_AUDIENCE,
  },
  spaceTypes: {
    [SPACE_TYPE]: {
      collections: [NOTE_COLLECTION, REACTION_COLLECTION],
      policy: "member-list",
      skey: SPACE_SKEY,
    },
  },
  subscriptions: { binding: "SPACE_SUBSCRIPTIONS" },
  accessLeaseMs: 2 * 60_000,
  notificationRegistration: (env) => {
    const hostname = new URL(env.OAUTH_PUBLIC_URL ?? PROVIDER_ENDPOINT).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
      ? "disabled"
      : "best-effort";
  },
  reconcileIntervalMs: 5 * 60_000,
});
