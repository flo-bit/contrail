/** Shared query-spec → event-translation logic.
 *
 *  Used by:
 *   - the Durable Object's WS publish path (per-subscriber filter after hibernation)
 *   - the Worker's SSE / Worker-terminated WS path (in-process filter)
 *
 *  Given a raw RealtimeEvent and a SubscriberQuerySpec, returns the list of
 *  `{kind, data}` envelopes to send to the subscriber, or `null` if the
 *  subscriber has no spec (i.e. raw-firehose mode). */

import type { RealtimeEvent } from "./types";
import type { SubscriberQuerySpec } from "./durable-object";

export type TranslatedEnvelope =
  | {
      kind: "record.created";
      data: {
        record: {
          uri: string;
          did: string;
          rkey: string;
          collection: string;
          cid: string | null | undefined;
          record: Record<string, unknown>;
          time_us: number;
          indexed_at: number;
          space: string;
        };
      };
    }
  | { kind: "record.deleted"; data: { uri: string; did: string; rkey: string } }
  | {
      kind: "hydration.added";
      data: {
        parentUri: string;
        relation: string;
        child: {
          uri: string;
          did: string;
          rkey: string;
          collection: string;
          cid: string | null | undefined;
          record: Record<string, unknown>;
          space: string;
        };
      };
    }
  | {
      kind: "hydration.removed";
      data: {
        parentUri: string;
        relation: string;
        childRkey: string;
        childDid?: string;
      };
    };

export interface SubscriberView {
  querySpec?: SubscriberQuerySpec;
  parentUris?: Set<string> | string[];
  childToParent?:
    | Map<string, { parentUri: string; relName: string }>
    | Record<string, { parentUri: string; relName: string }>;
}

export function translateForQuery(
  event: RealtimeEvent,
  sub: SubscriberView
): TranslatedEnvelope[] | null {
  const spec = sub.querySpec;
  if (!spec) return null;
  if (event.kind !== "record.created" && event.kind !== "record.deleted") return [];
  if (event.payload.space !== spec.spaceUri) return [];

  const primaryUri = `at://${event.payload.did}/${event.payload.collection}/${event.payload.rkey}`;

  if (event.payload.collection === spec.collection) {
    if (event.kind === "record.created") {
      return [
        {
          kind: "record.created",
          data: {
            record: {
              uri: primaryUri,
              did: event.payload.did,
              rkey: event.payload.rkey,
              collection: event.payload.collection,
              cid: event.payload.cid,
              record: event.payload.record,
              time_us: event.ts * 1000,
              indexed_at: event.ts,
              space: spec.spaceUri
            }
          }
        }
      ];
    }
    return [
      {
        kind: "record.deleted",
        data: {
          uri: primaryUri,
          did: event.payload.did,
          rkey: event.payload.rkey
        }
      }
    ];
  }

  if (!spec.hydrate) return [];
  for (const [relName, rel] of Object.entries(spec.hydrate)) {
    if (rel.childCollection !== event.payload.collection) continue;
    if (event.kind === "record.created") {
      const parentUri = getNestedValue(
        event.payload.record as Record<string, unknown>,
        rel.matchField
      );
      if (typeof parentUri !== "string") continue;
      if (!hasParent(sub.parentUris, parentUri)) continue;
      return [
        {
          kind: "hydration.added",
          data: {
            parentUri,
            relation: relName,
            child: {
              uri: primaryUri,
              did: event.payload.did,
              rkey: event.payload.rkey,
              collection: event.payload.collection,
              cid: event.payload.cid,
              record: event.payload.record,
              space: spec.spaceUri
            }
          }
        }
      ];
    }
    const info = getChildInfo(sub.childToParent, event.payload.rkey);
    if (!info || info.relName !== relName) continue;
    return [
      {
        kind: "hydration.removed",
        data: {
          parentUri: info.parentUri,
          relation: relName,
          childRkey: event.payload.rkey,
          childDid: event.payload.did
        }
      }
    ];
  }
  return [];
}

export function applyEnvelopesToSubscriber(
  subscriber: SubscriberView,
  envs: TranslatedEnvelope[]
): void {
  for (const msg of envs) {
    if (msg.kind === "record.created") {
      ensureParentSet(subscriber).add(msg.data.record.uri);
    } else if (msg.kind === "record.deleted") {
      const set = subscriber.parentUris;
      if (set instanceof Set) set.delete(msg.data.uri);
      else if (Array.isArray(set)) {
        const idx = set.indexOf(msg.data.uri);
        if (idx >= 0) set.splice(idx, 1);
      }
    } else if (msg.kind === "hydration.added") {
      ensureChildMap(subscriber).set(msg.data.child.rkey, {
        parentUri: msg.data.parentUri,
        relName: msg.data.relation
      });
    } else if (msg.kind === "hydration.removed") {
      const map = subscriber.childToParent;
      if (map instanceof Map) map.delete(msg.data.childRkey);
      else if (map && typeof map === "object") {
        delete (map as Record<string, unknown>)[msg.data.childRkey];
      }
    }
  }
}

function ensureParentSet(sub: SubscriberView): Set<string> {
  if (sub.parentUris instanceof Set) return sub.parentUris;
  const set = new Set<string>(sub.parentUris ?? []);
  sub.parentUris = set;
  return set;
}

function ensureChildMap(
  sub: SubscriberView
): Map<string, { parentUri: string; relName: string }> {
  if (sub.childToParent instanceof Map) return sub.childToParent;
  const map = new Map<string, { parentUri: string; relName: string }>();
  if (sub.childToParent && typeof sub.childToParent === "object") {
    for (const [k, v] of Object.entries(sub.childToParent)) map.set(k, v);
  }
  sub.childToParent = map;
  return map;
}

function hasParent(
  parents: Set<string> | string[] | undefined,
  uri: string
): boolean {
  if (!parents) return false;
  if (parents instanceof Set) return parents.has(uri);
  return parents.includes(uri);
}

function getChildInfo(
  map:
    | Map<string, { parentUri: string; relName: string }>
    | Record<string, { parentUri: string; relName: string }>
    | undefined,
  rkey: string
): { parentUri: string; relName: string } | undefined {
  if (!map) return undefined;
  if (map instanceof Map) return map.get(rkey);
  return map[rkey];
}

function getNestedValue(
  obj: Record<string, unknown>,
  path: string
): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
