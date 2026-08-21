import type { ContrailConfig } from "@atmo-dev/contrail";
import { createSpacesWorker } from "@atmo-dev/contrail-spaces-alpha/worker";
import { parseSpaceUri } from "@atmo-dev/contrail-spaces-alpha";
import {
  NOTE_COLLECTION,
  PROVIDER_AUDIENCE,
  PROVIDER_ENDPOINT,
  REACTION_COLLECTION,
  SPACE_SKEY,
  SPACE_TYPE,
} from "./constants";
import { lexicons } from "./lexicons";

interface Env {
  [key: string]: unknown;
  DB: D1Database;
  SPACES_QUEUE: Queue;
  SPACES_CREDENTIAL_ENCRYPTION_KEY: string;
  BSKY_APPVIEW_URL: string;
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

async function mutualAccess(
  userDid: string,
  ownerDid: string,
  appview: string,
): Promise<boolean> {
  if (userDid === ownerDid) return true;
  const url = new URL("/xrpc/app.bsky.graph.getRelationships", appview);
  url.searchParams.set("actor", userDid);
  url.searchParams.append("others", ownerDid);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return false;
  const body = await response.json() as {
    relationships?: Array<{
      $type?: string;
      did?: string;
      following?: unknown;
      followedBy?: unknown;
    }>;
  };
  const relation = body.relationships?.find((item) => item.did === ownerDid);
  return Boolean(relation?.following && relation.followedBy);
}

export default createSpacesWorker<Env>({
  projection,
  lexicons,
  service: {
    endpoint: PROVIDER_ENDPOINT,
    audience: PROVIDER_AUDIENCE,
  },
  spaceTypes: {
    [SPACE_TYPE]: {
      collections: [NOTE_COLLECTION, REACTION_COLLECTION],
      skey: SPACE_SKEY,
    },
  },
  authorization: {
    async authorize({ userDid, spaceUri }, { env }) {
      const space = parseSpaceUri(spaceUri);
      if (space.type !== SPACE_TYPE || space.skey !== SPACE_SKEY) return false;
      try {
        return await mutualAccess(
          userDid,
          space.authorityDid,
          env.BSKY_APPVIEW_URL || "https://public.api.bsky.app",
        );
      } catch (error) {
        console.warn("[circle] relationship policy failed closed", error);
        return false;
      }
    },
  },
  accessLeaseMs: 15 * 60_000,
  reconcileIntervalMs: 5 * 60_000,
});
