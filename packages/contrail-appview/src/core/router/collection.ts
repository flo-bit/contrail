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
import { selectAcceptedLabelers } from "../labels/select";
import { hydrateLabels } from "../labels/hydrate";
import { verifyServiceAuthRequest, extractInviteToken, checkInviteReadGrant } from "../spaces/auth";
import { checkAccess } from "../spaces/acl";
import { hashInviteToken } from "../invite/token";
import type { SpacesContext } from ".";
import type { Nsid } from "@atcute/lexicons";
import type { RealtimeEvent } from "../realtime/types";
import { sseResponse } from "../realtime/sse";
import { spaceTopic, communityTopic, parseSpaceTopic } from "../realtime/types";
import type { SubscriberQuerySpec } from "../realtime/durable-object";
import { DurableObjectPubSub } from "../realtime/durable-object";
import { TicketSigner, type TicketQuerySpec } from "../realtime/ticket";
import { resolveTopicForCaller } from "../realtime/resolve";
import { mergeAsyncIterables } from "../realtime/merge";
import type { CommunityProbe } from "../community-integration";
import { getRelationField, getNestedValue } from "../types";

/** Scope of a watch stream.
 *  - `space`: single permissioned space — one `space:<uri>` topic.
 *  - `actor`: records authored by `actor` across multiple spaces — the
 *    resolver expanded these to a per-caller subset of space topics (plus
 *    `actor:<did>` for public records). Events outside `allowedSpaces`
 *    are filtered out. */
type WatchScope =
  | { kind: "space"; spaceUri: string }
  | {
      kind: "actor";
      actor: string;
      /** Concrete pubsub topics to subscribe to (from resolveTopicForCaller). */
      topics: string[];
      /** Space URIs the caller can see. Events with `space` outside this
       *  set are dropped. Undefined `space` on an event (public record)
       *  is allowed only when `actor` topic is in `topics`. */
      allowedSpaces: Set<string>;
    };

/** Shared implementation of the watchRecords snapshot+live loop. Called by
 *  both transport branches (SSE and Worker-terminated WS). The caller owns
 *  the actual socket/stream and provides a `send(kind, data)` closure. */
async function runQueryStream(opts: {
  send: (kind: string, data: unknown) => void;
  abort: AbortController;
  scope: WatchScope;
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
    scope,
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

  // Predicate: does this event belong in the caller's scope?
  const inScope = (space: string | undefined): boolean => {
    if (scope.kind === "space") return space === scope.spaceUri;
    if (space == null) return false; // actor mode: require space for now (app topic)
    return scope.allowedSpaces.has(space);
  };

  const hydrateSpec = parseHydrateParams(params, relations, references);
  const trackHydration = Object.keys(hydrateSpec.relations).length > 0;
  const parentUris = new Set<string>();
  const parentDids = new Set<string>();
  const childToParent = new Map<string, { parentUri: string; relName: string }>();

  const primaryUri = (payload: { uri: string }) => payload.uri;

  const handleChildEvent = (event: RealtimeEvent) => {
    if (!trackHydration) return;
    if (event.kind !== "record.created" && event.kind !== "record.deleted") return;
    const meta = childCollectionMap.get(event.payload.collection);
    if (!meta) return;
    if (!(hydrateSpec.relations as Record<string, number>)[meta.relName]) return;
    if (!inScope(event.payload.space)) return;
    // Actor mode: additionally require the record's author match our actor
    // (the caller might share spaces with other authors — we only surface
    // records by the actor under watch).
    if (scope.kind === "actor" && event.payload.did !== scope.actor) return;

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
          did: event.payload.did,
          rkey: event.payload.rkey,
          collection: event.payload.collection,
          cid: event.payload.cid,
          value: event.payload.record,
          space: event.payload.space
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
        childDid: event.payload.did
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
    if (!inScope(event.payload.space)) return;
    if (scope.kind === "actor" && event.payload.did !== scope.actor) return;

    if (event.payload.collection !== colNsid) {
      handleChildEvent(event);
      return;
    }

    const nowUs = event.ts * 1000;
    const uri = primaryUri(event.payload);
    if (event.kind === "record.created") {
      parentUris.add(uri);
      parentDids.add(event.payload.did);
      send("record.created", {
        record: {
          uri,
          did: event.payload.did,
          rkey: event.payload.rkey,
          collection: event.payload.collection,
          cid: event.payload.cid,
          value: event.payload.record,
          time_us: nowUs,
          indexed_at: event.ts,
          space: event.payload.space
        }
      });
    } else {
      parentUris.delete(uri);
      send("record.deleted", {
        uri,
        did: event.payload.did,
        rkey: event.payload.rkey
      });
    }
  };

  // Subscribe: one topic for space-scoped, merge across all topics for
  // actor-scoped. `mergeAsyncIterables` exists for exactly this case.
  let iter: AsyncIterable<RealtimeEvent>;
  if (scope.kind === "space") {
    iter = pubsub.subscribe(spaceTopic(scope.spaceUri), abort.signal);
  } else {
    const sources = scope.topics.map((t) => pubsub.subscribe(t, abort.signal));
    iter = mergeAsyncIterables(sources, abort.signal);
  }

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
    send(
      "snapshot.start",
      scope.kind === "space"
        ? { spaceUri: scope.spaceUri, collection: colNsid }
        : { actor: scope.actor, collection: colNsid }
    );
    const snapshotSpaces =
      scope.kind === "space" ? [scope.spaceUri] : Array.from(scope.allowedSpaces);
    const result = await runPipeline(db, config, collection, params, undefined, snapshotSpaces);
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
  spaceUris?: string[],
  /** Optional headers from the originating request — used for label
   *  hydration (`atproto-accept-labelers`). Other entry points pass nothing
   *  and labels are gated by `?labelers=` / config defaults. */
  headers?: Headers
): Promise<{ records: FormattedRecord[]; cursor?: string; profiles?: any[]; labelersApplied?: string[] }> {
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

  let labelersApplied: string[] | undefined;
  if (config.labels) {
    const sel = selectAcceptedLabelers(
      headers?.get("atproto-accept-labelers") ?? null,
      params.get("labelers"),
      config.labels,
    );
    if (sel.accepted.length > 0) {
      const subjects: string[] = [
        ...formattedRecords.map((r) => r.uri),
        ...allDids,
      ];
      const cidByUri = new Map<string, string | null>();
      for (const r of formattedRecords) cidByUri.set(r.uri, r.cid);
      const labelsByUri = await hydrateLabels(db, subjects, sel.accepted, cidByUri);
      for (const fr of formattedRecords) {
        const ls = labelsByUri[fr.uri];
        if (ls && ls.length > 0) fr.labels = ls;
      }
      if (profileMap) {
        for (const entries of Object.values(profileMap)) {
          for (const entry of entries) {
            const ls = labelsByUri[entry.did];
            if (ls && ls.length > 0) entry.labels = ls;
          }
        }
      }
      labelersApplied = sel.accepted;
    }
  }

  return {
    records: formattedRecords,
    cursor: result.cursor,
    ...(profileMap ? { profiles: Object.values(profileMap).flat() } : {}),
    ...(labelersApplied ? { labelersApplied } : {}),
  };
}

/** Serialize a runPipeline result as JSON, echoing
 *  `atproto-content-labelers` when labels were applied. The result's
 *  `labelersApplied` field never appears in the response body — it's a
 *  side channel for the route to read and turn into a header. */
function jsonWithLabelers(c: Context, result: { labelersApplied?: string[] } & Record<string, unknown>) {
  const { labelersApplied, ...body } = result;
  if (labelersApplied && labelersApplied.length > 0) {
    c.header("atproto-content-labelers", labelersApplied.join(","));
  }
  return c.json(body);
}

export function registerCollectionRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  spacesCtx?: SpacesContext | null,
  options: {
    pubsub?: import("../realtime/types").PubSub | null;
    community?: CommunityProbe | null;
  } = {}
): void {
  const ns = config.namespace;
  const pubsub = options.pubsub ?? null;
  const community = options.community ?? null;

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
    const auth = await verifyServiceAuthRequest(spacesCtx.verifier, c.req.raw, nsid);
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
            const result = await runPipeline(db, config, collection, params, undefined, [spaceUri], c.req.raw.headers);
            return jsonWithLabelers(c, result);
          } catch (e: any) {
            if (e.message === "Could not resolve actor") {
              return c.json({ error: e.message }, 400);
            }
            throw e;
          }
        }

        // Union path: when the caller is authenticated, fold in records from
        // spaces they're a member of. Anonymous callers just get public results.
        //
        // The caller authenticates with service-auth (`Authorization: Bearer
        // <jwt>`). Their member-of space list comes from one of:
        //   1. `X-Membership-Manifest` header — signed list issued by some
        //      authority asserting `sub` is in these spaces. The manifest's
        //      `sub` MUST match the JWT's issuer (DID) — the manifest is not
        //      a bearer token. Preferred for multi-authority deployments.
        //   2. Local listSpaces — appview asks its own authority adapter
        //      `listSpaces({ memberDid: jwt.issuer })`. Works when the appview
        //      operator IS the authority.
        let spaceUris: string[] | undefined;
        const hasAuthHeader = !!c.req.header("Authorization");
        const manifestHeader = c.req.header("X-Membership-Manifest");
        if (spacesCtx) {
          const nsid = new URL(c.req.url).pathname.match(/\/xrpc\/([^?]+)/)?.[1] as Nsid | null;
          const auth = await verifyServiceAuthRequest(spacesCtx.verifier, c.req.raw, nsid);
          if (auth) {
            if (manifestHeader && spacesCtx.manifestVerifier) {
              const verified = await spacesCtx.manifestVerifier.verify(manifestHeader);
              if (!verified.ok) {
                return c.json(
                  { error: "AuthRequired", reason: verified.reason, message: "invalid membership manifest" },
                  401
                );
              }
              if (verified.claims.sub !== auth.issuer) {
                return c.json(
                  { error: "Forbidden", reason: "manifest-sub-mismatch", message: "manifest sub does not match caller" },
                  403
                );
              }
              spaceUris = verified.claims.spaces;
            } else {
              const { spaces } = await spacesCtx.adapter.listSpaces({
                memberDid: auth.issuer,
                limit: 200,
              });
              spaceUris = spaces.map((s) => s.uri);
            }
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
          const result = await runPipeline(db, config, collection, params, undefined, spaceUris, c.req.raw.headers);
          return jsonWithLabelers(c, result);
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
          const actorParam = params.get("actor");

          if (!spaceUri && !actorParam) {
            return c.json(
              { error: "InvalidRequest", message: "spaceUri or actor required" },
              400
            );
          }

          // Resolve the caller and their scope. Two parallel paths:
          //   - space-scoped: single `space:<uri>` topic, per-space ACL gate.
          //   - actor-scoped: caller's reachable spaces in the actor's
          //     community (v1 only supports community DIDs as the actor).
          //     Events are delivered via N `space:<uri>` topics and filtered
          //     to `did === actor`.
          let callerDid: string | undefined;
          let scope: WatchScope;
          let scopeTopics: string[]; // for ticket signing
          let ticketSpec: TicketQuerySpec | null = null;

          const providedTicket = params.get("ticket");
          if (providedTicket && ticketSigner) {
            const payload = await ticketSigner.verify(providedTicket);
            if (payload?.querySpec && payload.querySpec.collection === colNsid) {
              const ts = payload.querySpec;
              if (spaceUri && ts.spaceUri === spaceUri) {
                if (payload.topics.includes(spaceTopic(spaceUri))) {
                  callerDid = payload.did;
                  ticketSpec = {
                    collection: ts.collection,
                    spaceUri: ts.spaceUri,
                    ...(ts.hydrate ? { hydrate: ts.hydrate } : {})
                  };
                }
              } else if (actorParam && ts.actor === actorParam) {
                callerDid = payload.did;
                ticketSpec = {
                  collection: ts.collection,
                  actor: ts.actor,
                  ...(ts.hydrate ? { hydrate: ts.hydrate } : {})
                };
              }
            }
          }

          const hydrateSpec = parseHydrateParams(params, relations, references);
          const hydrateForSpec = Object.keys(hydrateSpec.relations).length > 0
            ? Object.fromEntries(
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
            : undefined;

          if (spaceUri) {
            if (!ticketSpec) {
              const gated = await gateSpaceAccess(c, spaceUri, "read");
              if (gated instanceof Response) return gated;
              callerDid = "callerDid" in gated ? gated.callerDid : undefined;
            }
            scope = { kind: "space", spaceUri };
            scopeTopics = [spaceTopic(spaceUri)];
          } else {
            // Actor-scoped path — v1 only supports community DIDs.
            const actor = actorParam!;
            if (!community || !spacesCtx) {
              return c.json(
                { error: "NotSupported", reason: "community-module-disabled" },
                400
              );
            }
            const isCommunity = !!(await community.getCommunity(actor));
            if (!isCommunity) {
              return c.json(
                { error: "InvalidRequest", reason: "actor-must-be-community-did", message: "cross-space watch currently only supports community DIDs as actor" },
                400
              );
            }

            if (!ticketSpec) {
              // Verify the caller via the same JWT/in-process path used for
              // per-space queries, then resolve the community topic to the
              // caller's accessible space topics.
              const nsidLxm = new URL(c.req.url).pathname.match(/\/xrpc\/([^?]+)/)?.[1] as Nsid | null;
              const auth = await verifyServiceAuthRequest(spacesCtx.verifier, c.req.raw, nsidLxm);
              if (!auth) {
                return c.json(
                  { error: "AuthRequired", message: "service-auth JWT or in-process principal required" },
                  401
                );
              }
              callerDid = auth.issuer;
            }
            const resolved = await resolveTopicForCaller(communityTopic(actor), callerDid!, {
              spaces: spacesCtx.adapter,
              community
            });
            if (!resolved.ok) {
              const status =
                resolved.error === "NotFound" ? 404 :
                resolved.error === "Forbidden" ? 403 : 400;
              return c.json({ error: resolved.error, reason: resolved.reason }, status);
            }
            const allowedSpaces = new Set<string>();
            for (const t of resolved.topics) {
              const uri = parseSpaceTopic(t);
              if (uri) allowedSpaces.add(uri);
            }
            scope = { kind: "actor", actor, topics: resolved.topics, allowedSpaces };
            scopeTopics = resolved.topics;
          }

          const querySpec: TicketQuerySpec = ticketSpec ?? {
            collection: colNsid,
            ...(spaceUri ? { spaceUri } : { actor: actorParam! }),
            ...(hydrateForSpec ? { hydrate: hydrateForSpec } : {})
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
            // upgrade. Ticket carries the (did, topics, querySpec) signed
            // so the WS-upgrade route skips any other auth.
            try {
              const sinceTs = Date.now();
              const snapshotSpaces =
                scope.kind === "space" ? [scope.spaceUri] : Array.from(scope.allowedSpaces);
              const result = await runPipeline(
                db,
                config,
                collection,
                params,
                undefined,
                snapshotSpaces,
                c.req.raw.headers
              );
              let ticket: string | undefined;
              if (ticketSigner && callerDid) {
                ticket = await ticketSigner.sign({
                  topics: scopeTopics,
                  did: callerDid,
                  ttlMs: ticketTtl,
                  querySpec
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

          if (isUpgrade && pubsub instanceof DurableObjectPubSub && scope.kind === "space") {
            // Forward the WS upgrade to the DO. The DO owns the socket from
            // here and hibernates when idle. Replays any events buffered
            // since the handshake `sinceTs` so the client closes the gap.
            //
            // Actor-scoped queries fall through to the worker-terminated
            // path below — the DO binding is single-topic today; extending
            // it to fan out over N topics is future work.
            const sinceTsParam = params.get("sinceTs");
            const sinceTs = sinceTsParam ? Number(sinceTsParam) : 0;
            return pubsub.forwardSubscribe(spaceTopic(scope.spaceUri), c.req.raw, {
              did: callerDid,
              querySpec: {
                collection: querySpec.collection,
                spaceUri: scope.spaceUri,
                ...(querySpec.hydrate ? { hydrate: querySpec.hydrate } : {})
              },
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
              scope,
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
                scope,
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

      let labelersApplied: string[] | undefined;
      if (config.labels) {
        const sel = selectAcceptedLabelers(
          c.req.raw.headers.get("atproto-accept-labelers"),
          params.get("labelers"),
          config.labels,
        );
        if (sel.accepted.length > 0) {
          const subjects: string[] = [row.uri, ...allDids];
          const cidByUri = new Map<string, string | null>([[row.uri, row.cid]]);
          const labelsByUri = await hydrateLabels(db, subjects, sel.accepted, cidByUri);
          const ls = labelsByUri[row.uri];
          if (ls && ls.length > 0) (formatted as Record<string, unknown>).labels = ls;
          if (profileMap) {
            for (const entries of Object.values(profileMap)) {
              for (const entry of entries) {
                const els = labelsByUri[entry.did];
                if (els && els.length > 0) entry.labels = els;
              }
            }
          }
          labelersApplied = sel.accepted;
        }
      }
      if (labelersApplied) {
        c.header("atproto-content-labelers", labelersApplied.join(","));
      }

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
          const result = await runPipeline(db, config, collection, params, source, undefined, c.req.raw.headers);
          return jsonWithLabelers(c, result);
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
