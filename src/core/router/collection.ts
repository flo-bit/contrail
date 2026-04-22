import type { Context, Hono } from "hono";
import type { ContrailConfig, ResolvedContrailConfig, Database, RecordRow, QueryableField, RecordSource, RelationConfig } from "../types";
import {
  getCollectionShortNames,
  countColumnName,
  groupedCountColumnName,
  recordsTableName,
  nsidForShortName,
  getCollectionMethods,
} from "../types";
import { queryRecords, queryAcrossSources } from "../db";
import type { SortOption } from "../db/records";
import { backfillUser } from "../backfill";
import { resolveHydrates, resolveReferences, parseHydrateParams } from "./hydrate";
import { resolveProfiles, collectDids } from "./profiles";
import { resolveActor } from "../identity";
import type { FormattedRecord } from "./helpers";
import { formatRecord, parseIntParam, fieldToParam } from "./helpers";
import { verifyServiceAuthRequest, extractInviteToken, checkInviteReadGrant } from "../spaces/auth";
import { checkAccess } from "../spaces/acl";
import { hashInviteToken } from "../spaces/invite-token";
import type { SpacesContext } from ".";
import type { Nsid } from "@atcute/lexicons";
import type { RealtimeEvent } from "../realtime/types";
import { sseResponse } from "../realtime/sse";
import { spaceTopic } from "../realtime/types";
import type { SubscriberQuerySpec } from "../realtime/durable-object";
import { DurableObjectPubSub } from "../realtime/durable-object";
import { TicketSigner, type TicketQuerySpec } from "../realtime/ticket";
import { parseHydrateParams } from "./hydrate";
import { getRelationField, getNestedValue, nsidForShortName } from "../types";

/** Shared implementation of the watchRecords snapshot+live loop. Called by
 *  both transport branches (SSE and Worker-terminated WS). The caller owns
 *  the actual socket/stream and provides a `send(kind, data)` closure. */
async function runQueryStream(opts: {
  send: (kind: string, data: unknown) => void;
  abort: AbortController;
  spaceUri: string;
  callerDid: string | undefined;
  params: URLSearchParams;
  db: Database;
  config: ContrailConfig;
  collection: string;
  colNsid: string;
  pubsub: import("../realtime/types").PubSub;
  relations: Record<string, import("../types").RelationConfig>;
  references: Record<string, import("../types").ReferenceConfig>;
  childCollectionMap: Map<
    string,
    { relName: string; matchField: string; matchMode: "uri" | "did" }
  >;
}): Promise<void> {
  const {
    send,
    abort,
    spaceUri,
    callerDid,
    params,
    db,
    config,
    collection,
    colNsid,
    pubsub,
    relations,
    references,
    childCollectionMap
  } = opts;

  const hydrateSpec = parseHydrateParams(params, relations, references);
  const trackHydration = Object.keys(hydrateSpec.relations).length > 0;
  const parentUris = new Set<string>();
  const parentDids = new Set<string>();
  const childToParent = new Map<string, { parentUri: string; relName: string }>();

  const primaryUri = (payload: { authorDid: string; collection: string; rkey: string }) =>
    `at://${payload.authorDid}/${payload.collection}/${payload.rkey}`;

  const handleChildEvent = (event: RealtimeEvent) => {
    if (!trackHydration) return;
    if (event.kind !== "record.created" && event.kind !== "record.deleted") return;
    const meta = childCollectionMap.get(event.payload.collection);
    if (!meta) return;
    if (!(hydrateSpec.relations as Record<string, number>)[meta.relName]) return;
    if (event.payload.spaceUri !== spaceUri) return;

    if (event.kind === "record.created") {
      const matched = getNestedValue(event.payload.record, meta.matchField);
      if (matched == null) return;
      const parent =
        meta.matchMode === "did"
          ? parentDids.has(String(matched))
            ? `at://${String(matched)}/${colNsid}/_`
            : null
          : parentUris.has(String(matched))
            ? String(matched)
            : null;
      if (!parent) return;
      childToParent.set(event.payload.rkey, {
        parentUri: parent,
        relName: meta.relName
      });
      send("hydration.added", {
        parentUri: parent,
        relation: meta.relName,
        child: {
          uri: primaryUri(event.payload),
          did: event.payload.authorDid,
          rkey: event.payload.rkey,
          collection: event.payload.collection,
          cid: event.payload.cid,
          record: event.payload.record,
          _space: spaceUri
        }
      });
    } else {
      const info = childToParent.get(event.payload.rkey);
      if (!info) return;
      childToParent.delete(event.payload.rkey);
      send("hydration.removed", {
        parentUri: info.parentUri,
        relation: info.relName,
        childRkey: event.payload.rkey,
        childDid: event.payload.authorDid
      });
    }
  };

  const handleLive = (event: RealtimeEvent) => {
    if (abort.signal.aborted) return;
    if (event.kind === "member.removed" && event.payload.did === callerDid) {
      send("member.removed", event.payload);
      abort.abort();
      return;
    }
    if (event.kind !== "record.created" && event.kind !== "record.deleted") return;
    if (event.payload.spaceUri !== spaceUri) return;

    if (event.payload.collection !== colNsid) {
      handleChildEvent(event);
      return;
    }

    const nowUs = event.ts * 1000;
    const uri = primaryUri(event.payload);
    if (event.kind === "record.created") {
      parentUris.add(uri);
      parentDids.add(event.payload.authorDid);
      send("record.created", {
        record: {
          uri,
          did: event.payload.authorDid,
          rkey: event.payload.rkey,
          collection: event.payload.collection,
          cid: event.payload.cid,
          record: event.payload.record,
          time_us: nowUs,
          indexed_at: event.ts,
          _space: spaceUri
        }
      });
    } else {
      parentUris.delete(uri);
      send("record.deleted", {
        uri,
        did: event.payload.authorDid,
        rkey: event.payload.rkey
      });
    }
  };

  const topic = spaceTopic(spaceUri);
  const iter = pubsub.subscribe(topic, abort.signal);

  const buffered: RealtimeEvent[] = [];
  let snapshotDone = false;

  const pump = (async () => {
    try {
      for await (const event of iter) {
        if (abort.signal.aborted) break;
        if (!snapshotDone) buffered.push(event);
        else handleLive(event);
      }
    } catch {
      /* aborted or errored */
    }
  })();

  try {
    send("snapshot.start", { spaceUri, collection: colNsid });
    const result = await runPipeline(db, config, collection, params, undefined, [spaceUri]);
    for (const record of result.records) {
      if (abort.signal.aborted) break;
      if (typeof record.uri === "string") parentUris.add(record.uri);
      if (typeof record.did === "string") parentDids.add(record.did);
      for (const [relName] of Object.entries(hydrateSpec.relations)) {
        const hydratedGroups = (record as Record<string, unknown>)[relName];
        if (!hydratedGroups) continue;
        const flat: Array<{ rkey?: string }> = Array.isArray(hydratedGroups)
          ? (hydratedGroups as Array<{ rkey?: string }>)
          : (Object.values(hydratedGroups as Record<string, unknown>).flat() as Array<{
              rkey?: string;
            }>);
        for (const child of flat) {
          if (child?.rkey) {
            childToParent.set(child.rkey, {
              parentUri: record.uri as string,
              relName
            });
          }
        }
      }
      send("snapshot.record", { record });
    }
    send("snapshot.end", { cursor: result.cursor });
    snapshotDone = true;
    for (const event of buffered) handleLive(event);
  } catch (err) {
    send("error", {
      message: err instanceof Error ? err.message : String(err)
    });
    abort.abort();
  }

  await pump.catch(() => {});
}

export async function runPipeline(
  db: Database,
  config: ContrailConfig,
  collection: string,
  params: URLSearchParams,
  source?: RecordSource,
  spaceUris?: string[]
): Promise<{ records: FormattedRecord[]; cursor?: string; profiles?: any[] }> {
  const colConfig = config.collections[collection];
  if (!colConfig) throw new Error(`Unknown collection: ${collection}`);

  const relations = colConfig.relations ?? {};
  const references = colConfig.references ?? {};
  const queryableFields: Record<string, QueryableField> =
    (config as ResolvedContrailConfig)._resolved?.queryable[collection] ?? colConfig.queryable ?? {};

  const limit = parseIntParam(params.get("limit"), 50);
  const cursor = params.get("cursor") || undefined;
  const actor = params.get("actor") || params.get("did") || undefined;
  const wantProfiles = params.get("profiles") === "true";

  let did: string | undefined;
  if (actor) {
    const resolved = await resolveActor(db, actor);
    if (!resolved) throw new Error("Could not resolve actor");
    did = resolved;
    // backfillUser expects the record NSID (for PDS calls), not the short name.
    const nsid = nsidForShortName(config, collection) ?? collection;
    await backfillUser(db, did, nsid, Date.now() + 3_000, config, {
      maxRetries: 0,
      requestTimeout: 3_000,
    });
  }

  const filters: Record<string, string> = {};
  const rangeFilters: Record<string, { min?: string; max?: string }> = {};
  for (const [field, fieldConfig] of Object.entries(queryableFields)) {
    const param = fieldToParam(field);
    if (fieldConfig.type === "range") {
      const min = params.get(`${param}Min`);
      const max = params.get(`${param}Max`);
      if (min || max) {
        rangeFilters[field] = {};
        if (min) rangeFilters[field].min = min;
        if (max) rangeFilters[field].max = max;
      }
    } else {
      const value = params.get(param);
      if (value) filters[field] = value;
    }
  }

  const countFilters: Record<string, number> = {};
  const relMap = (config as ResolvedContrailConfig)._resolved?.relations[collection] ?? {};
  for (const [relName, rel] of Object.entries(relations)) {
    const totalMin = parseIntParam(params.get(`${relName}CountMin`));
    if (totalMin != null) countFilters[rel.collection] = totalMin;
    const mapping = relMap[relName];
    if (mapping) {
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
        const val = parseIntParam(params.get(`${relName}${capitalize(shortName)}CountMin`));
        if (val != null) countFilters[fullToken] = val;
      }
    }
  }

  let sort: SortOption | undefined;
  const sortParam = params.get("sort");
  if (sortParam) {
    const orderParam = params.get("order");

    const fieldEntry = Object.entries(queryableFields).find(
      ([field]) => fieldToParam(field) === sortParam
    );
    if (fieldEntry) {
      const defaultDir = fieldEntry[1].type === "range" ? "desc" : "asc";
      const direction = orderParam === "asc" ? "asc" as const : orderParam === "desc" ? "desc" as const : defaultDir as "asc" | "desc";
      sort = { recordField: fieldEntry[0], direction };
    } else {
      const direction = orderParam === "asc" ? "asc" as const : "desc" as const;
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      for (const [relName, rel] of Object.entries(relations)) {
        if (sortParam === `${relName}Count`) {
          sort = { countType: rel.collection, direction };
          break;
        }
        const mapping = relMap[relName];
        if (mapping) {
          for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
            if (sortParam === `${relName}${capitalize(shortName)}Count`) {
              sort = { countType: fullToken, direction };
              break;
            }
          }
          if (sort) break;
        }
      }
    }
  }

  const search = params.get("search") || undefined;
  const spaceUri = params.get("spaceUri") || undefined;

  const queryOpts = {
    collection,
    did,
    limit,
    cursor,
    filters,
    rangeFilters,
    countFilters,
    sort,
    search,
    source,
    spaceUri,
  };
  const result = spaceUris && spaceUris.length > 0 && !spaceUri
    ? await queryAcrossSources(db, config, queryOpts, spaceUris)
    : await queryRecords(db, config, queryOpts);

  const rows = result.records;
  const hydrateRequested = parseHydrateParams(params, relations, references);
  const hydrates = await resolveHydrates(
    db,
    relations,
    hydrateRequested.relations,
    rows,
    config
  );
  const refs = await resolveReferences(
    db,
    references,
    hydrateRequested.references,
    rows,
    config
  );

  const formattedRecords: FormattedRecord[] = rows.map((row) => {
    const formatted = formatRecord(row);
    flattenCounts(formatted, row.counts, relations);
    const h = hydrates[row.uri];
    if (h) {
      for (const [relName, groups] of Object.entries(h)) {
        formatted[relName] = groups;
      }
    }
    const r = refs[row.uri];
    if (r) {
      for (const [refName, record] of Object.entries(r)) {
        formatted[refName] = record;
      }
    }
    return formatted;
  });

  const allDids = collectDids(rows, hydrates);
  const profileMap = wantProfiles
    ? await resolveProfiles(db, config, allDids)
    : undefined;

  return {
    records: formattedRecords,
    cursor: result.cursor,
    ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
  };
}

export function registerCollectionRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  spacesCtx?: SpacesContext | null,
  options: { pubsub?: import("../realtime/types").PubSub | null } = {}
): void {
  const ns = config.namespace;
  const pubsub = options.pubsub ?? null;

  /** When a per-collection endpoint receives `?spaceUri=...`, verify the JWT,
   *  resolve membership, run the space ACL, and return the caller DID if allowed.
   *  Returns null if the spaces subsystem isn't available; the handler should
   *  then treat the spaceUri as invalid.
   *  Throws by returning a Response (caller checks via `instanceof Response`). */
  async function gateSpaceAccess(
    c: Context,
    spaceUri: string,
    op: "read"
  ): Promise<Response | { callerDid?: string; clientId?: string; viaInviteToken?: boolean }> {
    if (!spacesCtx) {
      return c.json(
        { error: "InvalidRequest", message: "spaces not configured on this service" },
        501
      );
    }

    // Read-token path: anonymous bearer access via `?inviteToken=...` (or
    // `Authorization: Bearer atmo-invite:<token>`). Token must exist, be
    // unexpired/unrevoked, scoped to this space, and have a kind that grants
    // read (`read` or `read-join`). Token kind cannot grant write — caller must
    // separately redeem to become a member for any non-read op.
    if (op === "read") {
      const rawToken = extractInviteToken(c.req.raw);
      if (rawToken) {
        const ok = await checkInviteReadGrant(
          spacesCtx.adapter,
          rawToken,
          spaceUri,
          hashInviteToken
        );
        if (ok) {
          const space = await spacesCtx.adapter.getSpace(spaceUri);
          if (!space) return c.json({ error: "NotFound" }, 404);
          return { viaInviteToken: true };
        }
        return c.json(
          { error: "Forbidden", reason: "invalid-invite-token" },
          403
        );
      }
    }

    const nsid = new URL(c.req.url).pathname.match(/\/xrpc\/([^?]+)/)?.[1] as Nsid | null;
    const auth = await verifyServiceAuthRequest(spacesCtx.verifier, c.req.raw, nsid, {
      authOverride: config.spaces?.authOverride,
    });
    if (!auth) {
      return c.json(
        { error: "AuthRequired", message: "spaceUri requires a valid service-auth JWT or read-grant invite token" },
        401
      );
    }
    const space = await spacesCtx.adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    const member = await spacesCtx.adapter.getMember(spaceUri, auth.issuer);
    const result = checkAccess({
      op,
      space,
      callerDid: auth.issuer,
      member,
      clientId: auth.clientId,
    });
    if (!result.allow) {
      return c.json({ error: "Forbidden", reason: result.reason }, 403);
    }
    return { callerDid: auth.issuer, clientId: auth.clientId };
  }

  for (const collection of getCollectionShortNames(config)) {
    const colConfig = config.collections[collection];
    const methods = getCollectionMethods(colConfig);

    if (methods.includes("listRecords")) {
      app.get(`/xrpc/${ns}.${collection}.listRecords`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        const spaceUri = params.get("spaceUri") || undefined;

        if (spaceUri) {
          const gated = await gateSpaceAccess(c, spaceUri, "read");
          if (gated instanceof Response) return gated;
          // Route through runPipeline with a single-element space list so the
          // full filter / sort / hydrate / reference surface works on per-space
          // queries too, not just on the cross-space union path.
          try {
            const result = await runPipeline(db, config, collection, params, undefined, [spaceUri]);
            return c.json(result);
          } catch (e: any) {
            if (e.message === "Could not resolve actor") {
              return c.json({ error: e.message }, 400);
            }
            throw e;
          }
        }

        // Union path: when Authorization is present (or the dev-mode override
        // can supply claims without one), verify and fold in records from
        // spaces the caller is a member of.
        let spaceUris: string[] | undefined;
        const hasAuthHeader = !!c.req.header("Authorization");
        const hasOverride = !!config.spaces?.authOverride;
        if (spacesCtx && (hasAuthHeader || hasOverride)) {
          const nsid = new URL(c.req.url).pathname.match(/\/xrpc\/([^?]+)/)?.[1] as Nsid | null;
          const auth = await verifyServiceAuthRequest(spacesCtx.verifier, c.req.raw, nsid, {
            authOverride: config.spaces?.authOverride,
          });
          if (auth) {
            const { spaces } = await spacesCtx.adapter.listSpaces({
              memberDid: auth.issuer,
              limit: 200,
            });
            spaceUris = spaces.map((s) => s.uri);
          } else if (hasAuthHeader) {
            // Had an auth header but it was invalid — reject rather than
            // silently downgrading to public results.
            return c.json(
              { error: "AuthRequired", message: "invalid service-auth JWT" },
              401
            );
          }
        }

        try {
          const result = await runPipeline(db, config, collection, params, undefined, spaceUris);
          return c.json(result);
        } catch (e: any) {
          if (e.message === "Could not resolve actor") {
            return c.json({ error: e.message }, 400);
          }
          throw e;
        }
      });

      // Streaming variant — same query shape, SSE'd forever. Opted in via the
      // presence of the realtime module; no explicit method config needed.
      if (pubsub && spacesCtx) {
        const colNsid = colConfig.collection;
        const relations = colConfig.relations ?? {};
        const references = colConfig.references ?? {};
        // Map child-NSID → { relName, matchField } so we can route child
        // events to hydration deltas without re-parsing config per event.
        const childCollectionMap = new Map<
          string,
          { relName: string; matchField: string; matchMode: "uri" | "did" }
        >();
        for (const [relName, rel] of Object.entries(relations)) {
          const childNsid = nsidForShortName(config, rel.collection) ?? rel.collection;
          childCollectionMap.set(childNsid, {
            relName,
            matchField: getRelationField(rel),
            matchMode: rel.match ?? "uri"
          });
        }

        // TicketSigner for watch-scoped tickets. Minted on `mode=ws` handshake
        // so the subsequent WS upgrade can auth with just `?ticket=...` (no
        // cookie or JWT needed — enables cross-origin + stateless clients).
        const ticketSigner = config.realtime?.ticketSecret
          ? new TicketSigner(config.realtime.ticketSecret)
          : null;
        const ticketTtl = config.realtime?.ticketTtlMs ?? 120_000;

        app.get(`/xrpc/${ns}.${collection}.watchRecords`, async (c) => {
          const params = new URL(c.req.url).searchParams;
          const spaceUri = params.get("spaceUri");
          if (!spaceUri) {
            return c.json(
              { error: "InvalidRequest", message: "spaceUri required (cross-space watch is deferred)" },
              400
            );
          }

          // Try ticket-auth first: if a valid watch ticket scoped to this
          // spaceUri/collection is present, use it and skip the JWT gate.
          let callerDid: string | undefined;
          let querySpec: SubscriberQuerySpec;
          let ticketSpec: SubscriberQuerySpec | null = null;

          const providedTicket = params.get("ticket");
          if (providedTicket && ticketSigner) {
            const payload = await ticketSigner.verify(providedTicket);
            if (payload?.querySpec) {
              const ts = payload.querySpec;
              if (
                ts.collection === colNsid &&
                ts.spaceUri === spaceUri &&
                payload.topics.includes(spaceTopic(spaceUri))
              ) {
                callerDid = payload.did;
                ticketSpec = {
                  collection: ts.collection,
                  spaceUri: ts.spaceUri,
                  ...(ts.hydrate ? { hydrate: ts.hydrate } : {})
                };
              }
            }
          }

          if (!ticketSpec) {
            const gated = await gateSpaceAccess(c, spaceUri, "read");
            if (gated instanceof Response) return gated;
            callerDid = "callerDid" in gated ? gated.callerDid : undefined;
          }

          // Build the query spec the DO will filter events against. Prefer
          // the ticket's spec when present (guarantees parity with what the
          // client asked for at handshake time, no param drift).
          const hydrateSpec = parseHydrateParams(params, relations, references);
          querySpec = ticketSpec ?? {
            collection: colNsid,
            spaceUri,
            ...(Object.keys(hydrateSpec.relations).length > 0
              ? {
                  hydrate: Object.fromEntries(
                    Object.entries(hydrateSpec.relations).map(([relName]) => {
                      const rel = relations[relName]!;
                      const childNsid =
                        nsidForShortName(config, rel.collection) ?? rel.collection;
                      return [
                        relName,
                        { childCollection: childNsid, matchField: getRelationField(rel) }
                      ];
                    })
                  )
                }
              : {})
          };

          // Upgrade-to-WS path — forward directly to the DO with the spec,
          // so the DO terminates the socket and hibernates when idle.
          // Requires snapshot to be fetched separately (see `mode=ws` JSON
          // handshake below) or accepted as lossy-on-connect for a plain WS
          // upgrade.
          const isUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
          const isWsMode = params.get("mode") === "ws";

          if (isWsMode && !isUpgrade) {
            // Handshake: return snapshot + a ticket the client uses to
            // upgrade. Ticket carries the (did, topic, querySpec) signed
            // so the WS-upgrade route skips any other auth.
            try {
              // Capture a server-side timestamp BEFORE running the snapshot.
              // Any event published after this moment will have ts > sinceTs
              // and be replayed by the DO on WS connect — so the client
              // never misses events during the snapshot→WS gap.
              const sinceTs = Date.now();
              const result = await runPipeline(
                db,
                config,
                collection,
                params,
                undefined,
                [spaceUri]
              );
              let ticket: string | undefined;
              if (ticketSigner && callerDid) {
                ticket = await ticketSigner.sign({
                  topics: [spaceTopic(spaceUri)],
                  did: callerDid,
                  ttlMs: ticketTtl,
                  querySpec: querySpec as TicketQuerySpec
                });
              }
              const wsUrl = (() => {
                const u = new URL(c.req.url);
                u.searchParams.delete("mode");
                if (ticket) u.searchParams.set("ticket", ticket);
                u.searchParams.set("sinceTs", String(sinceTs));
                return u.pathname + u.search;
              })();
              return c.json({
                transport: "ws",
                snapshot: { records: result.records, cursor: result.cursor },
                querySpec,
                ticket,
                ticketTtlMs: ticketTtl,
                sinceTs,
                wsUrl
              });
            } catch (err) {
              return c.json(
                { error: "SnapshotFailed", message: err instanceof Error ? err.message : String(err) },
                500
              );
            }
          }

          if (isUpgrade && pubsub instanceof DurableObjectPubSub) {
            // Forward the WS upgrade to the DO. The DO owns the socket from
            // here and hibernates when idle. Replays any events buffered
            // since the handshake `sinceTs` so the client closes the gap.
            const sinceTsParam = params.get("sinceTs");
            const sinceTs = sinceTsParam ? Number(sinceTsParam) : 0;
            return pubsub.forwardSubscribe(spaceTopic(spaceUri), c.req.raw, {
              did: callerDid,
              querySpec,
              sinceTs: Number.isFinite(sinceTs) ? sinceTs : 0
            });
          }

          const ac = new AbortController();
          const reqSignal = c.req.raw.signal;
          if (reqSignal) {
            if (reqSignal.aborted) ac.abort();
            else reqSignal.addEventListener("abort", () => ac.abort(), { once: true });
          }

          // Worker-terminated WebSocket — used when pubsub isn't DO-backed
          // (dev InMemoryPubSub). Same query-filter loop as SSE; different
          // transport. Runs in the same isolate so no cost benefit, but
          // matches the prod protocol.
          if (isUpgrade) {
            const WsPair = (globalThis as unknown as { WebSocketPair?: any }).WebSocketPair;
            if (!WsPair) {
              return c.json(
                { error: "NotSupported", reason: "websockets-require-workers-runtime" },
                426
              );
            }
            const pair = new WsPair();
            const clientWs = pair[0] as WebSocket;
            const serverWs = pair[1] as WebSocket & { accept?: () => void };
            serverWs.accept?.();

            const sendWs = (kind: string, data: unknown) => {
              try {
                serverWs.send(JSON.stringify({ kind, data }));
              } catch {
                ac.abort();
              }
            };
            serverWs.addEventListener?.("close", () => ac.abort());
            serverWs.addEventListener?.("error", () => ac.abort());

            void runQueryStream({
              send: sendWs,
              abort: ac,
              spaceUri,
              callerDid,
              params,
              db,
              config,
              collection,
              colNsid,
              pubsub,
              relations,
              references,
              childCollectionMap
            }).finally(() => {
              try {
                serverWs.close();
              } catch {
                /* ignore */
              }
            });

            return new Response(null, {
              status: 101,
              webSocket: clientWs
            } as ResponseInit & { webSocket: unknown });
          }

          // SSE fallback.
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false;
              const close = () => {
                if (closed) return;
                closed = true;
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
              };
              ac.signal.addEventListener("abort", close, { once: true });

              const send = (kind: string, data: unknown) => {
                if (closed) return;
                try {
                  controller.enqueue(
                    encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)
                  );
                } catch {
                  close();
                }
              };

              const keepalive = setInterval(() => {
                if (closed) return;
                try {
                  controller.enqueue(encoder.encode(`: keepalive\n\n`));
                } catch {
                  close();
                }
              }, 15_000);
              ac.signal.addEventListener(
                "abort",
                () => clearInterval(keepalive),
                { once: true }
              );

              void runQueryStream({
                send,
                abort: ac,
                spaceUri,
                callerDid,
                params,
                db,
                config,
                collection,
                colNsid,
                pubsub,
                relations,
                references,
                childCollectionMap
              }).finally(() => close());
            },
            cancel() {
              ac.abort();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          });
        });
      }
    }

    if (!methods.includes("getRecord")) {
      // Skip getRecord + custom queries unless listRecords-only was explicitly requested.
      for (const [queryName, handler] of Object.entries(colConfig.queries ?? {})) {
        app.get(`/xrpc/${ns}.${collection}.${queryName}`, async (c) => {
          const params = new URL(c.req.url).searchParams;
          return handler(db, params, config);
        });
      }
      continue;
    }

    app.get(`/xrpc/${ns}.${collection}.getRecord`, async (c) => {
      const uri = c.req.query("uri");
      if (!uri) return c.json({ error: "uri parameter required" }, 400);

      // Spaces path — `?spaceUri=` routes to the per-space store + ACL gate.
      const spaceUri = c.req.query("spaceUri") || undefined;
      if (spaceUri) {
        const gated = await gateSpaceAccess(c, spaceUri, "read");
        if (gated instanceof Response) return gated;

        // Parse author + rkey from the record uri `at://<did>/<collection>/<rkey>`
        const m = uri.match(/^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/);
        if (!m) return c.json({ error: "InvalidRequest", message: "uri must be at://<did>/<collection>/<rkey>" }, 400);
        const authorDid = m[1];
        const rkey = m[2];

        const nsid = colConfig.collection;
        const record = await spacesCtx!.adapter.getRecord(spaceUri, nsid, authorDid, rkey);
        if (!record) return c.json({ error: "NotFound" }, 404);
        return c.json({ record });
      }

      const relations = colConfig.relations ?? {};
      const references = colConfig.references ?? {};
      const relMap = (config as ResolvedContrailConfig)._resolved?.relations[collection] ?? {};

      const table = recordsTableName(collection);
      const countCols = getRelationCountColumns(relations, relMap);
      const selectCols = `uri, did, rkey, cid, record, time_us, indexed_at${countCols.length > 0 ? ", " + countCols.map(c => c.column).join(", ") : ""}`;
      const row = await db
        .prepare(`SELECT ${selectCols} FROM ${table} WHERE uri = ?`)
        .bind(uri)
        .first<any>();

      if (!row) return c.json({ error: "Record not found" }, 404);

      const nsid = nsidForShortName(config, collection) ?? collection;
      const formatted = formatRecord({ ...row, collection: nsid });
      const counts = extractCounts(row, relations);
      if (counts) flattenCounts(formatted, counts, relations);

      const params = new URL(c.req.url).searchParams;
      const wantProfilesSingle = params.get("profiles") === "true";

      const hydrateRequested = parseHydrateParams(params, relations, references);
      const hydrates = await resolveHydrates(
        db,
        relations,
        hydrateRequested.relations,
        [row],
        config
      );
      const refs = await resolveReferences(
        db,
        references,
        hydrateRequested.references,
        [row],
        config
      );
      const h = hydrates[row.uri];
      if (h) {
        for (const [relName, groups] of Object.entries(h)) {
          (formatted as any)[relName] = groups;
        }
      }
      const r = refs[row.uri];
      if (r) {
        for (const [refName, record] of Object.entries(r)) {
          (formatted as any)[refName] = record;
        }
      }

      const allDids = collectDids([row], hydrates);
      const profileMap = wantProfilesSingle
        ? await resolveProfiles(db, config, allDids)
        : undefined;

      return c.json({
        ...formatted,
        ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
      });
    });

    for (const [queryName, handler] of Object.entries(
      colConfig.queries ?? {}
    )) {
      app.get(`/xrpc/${ns}.${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        return handler(db, params, config);
      });
    }

    for (const [queryName, handler] of Object.entries(
      colConfig.pipelineQueries ?? {}
    )) {
      app.get(`/xrpc/${ns}.${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        try {
          const source = await handler(db, params, config);
          const result = await runPipeline(db, config, collection, params, source);
          return c.json(result);
        } catch (e: any) {
          if (e.message === "Could not resolve actor") {
            return c.json({ error: e.message }, 400);
          }
          throw e;
        }
      });
    }
  }
}

function getRelationCountColumns(
  relations: Record<string, RelationConfig>,
  relMap: Record<string, any>
): { column: string }[] {
  const cols: { column: string }[] = [];
  for (const [relName, rel] of Object.entries(relations)) {
    if (rel.count === false) continue;
    cols.push({ column: countColumnName(rel.collection) });
    const mapping = relMap[relName];
    if (mapping?.groups) {
      for (const groupKey of Object.keys(mapping.groups as Record<string, string>)) {
        cols.push({ column: groupedCountColumnName(rel.collection, groupKey) });
      }
    }
  }
  return cols;
}

function extractCounts(
  row: any,
  relations: Record<string, any>
): Record<string, number> | undefined {
  const counts: Record<string, number> = {};

  for (const [, rel] of Object.entries(relations)) {
    if (rel.count === false) continue;
    const totalCol = countColumnName(rel.collection);
    const val = row[totalCol];
    if (val != null && val !== 0) counts[rel.collection] = val;

    if (rel.groups) {
      for (const [groupKey, fullToken] of Object.entries(rel.groups as Record<string, string>)) {
        const groupCol = groupedCountColumnName(rel.collection, groupKey);
        const gval = row[groupCol];
        if (gval != null && gval !== 0) counts[fullToken] = gval;
      }
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

function flattenCounts(
  formatted: FormattedRecord,
  counts: Record<string, number> | undefined,
  relations: Record<string, any>
): void {
  if (!counts) return;
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const collectionToRelName: Record<string, string> = {};
  const tokenToField: Record<string, string> = {};
  for (const [relName, rel] of Object.entries(relations)) {
    collectionToRelName[rel.collection] = relName;
    if (rel.groups) {
      for (const [shortName, fullToken] of Object.entries(rel.groups as Record<string, string>)) {
        tokenToField[fullToken] = `${relName}${capitalize(shortName)}Count`;
      }
    }
  }

  for (const [type, count] of Object.entries(counts)) {
    if (collectionToRelName[type]) {
      formatted[`${collectionToRelName[type]}Count`] = count;
    } else if (tokenToField[type]) {
      formatted[tokenToField[type]] = count;
    }
  }
}
