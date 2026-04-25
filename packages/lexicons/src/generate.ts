/**
 * Core lexicon generation logic, importable for testing.
 *
 * Builds lexicon JSON objects from a ContrailConfig. Separated from the
 * script entry point so tests can call it with custom configs and output dirs.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import type { ContrailConfig } from "@atmo-dev/contrail";

/** Return the sorted list of XRPC method NSIDs (queries + procedures) in a
 *  generated lexicon set — the same list that ends up in `<ns>.permissionSet`'s
 *  `lxm`. Use when the permission set isn't published yet and you need the
 *  scoped method list inline (e.g. in an OAuth client config).
 *
 *  Filters `defs.main.type === "query" | "procedure"`. Sorted alphabetically
 *  so the output is stable across runs. */
export function extractXrpcMethods(generated: Record<string, object>): string[] {
  const methods: string[] = [];
  for (const [nsid, doc] of Object.entries(generated)) {
    const mainType = (doc as { defs?: { main?: { type?: string } } })?.defs?.main?.type;
    if (mainType === "query" || mainType === "procedure") methods.push(nsid);
  }
  return methods.sort();
}

/** Generate lexicons in-memory and return the sorted method NSID list.
 *  Convenience wrapper over `generateLexicons` + `extractXrpcMethods` for
 *  callers that don't care about the full lexicon map. */
export function listXrpcMethods(
  config: ContrailConfig,
  options: { rootDir: string; lexiconDirs?: string[] }
): string[] {
  const generated = generateLexicons({
    config,
    rootDir: options.rootDir,
    lexiconDirs: options.lexiconDirs,
    quiet: true,
  });
  return extractXrpcMethods(generated);
}

export interface GenerateOptions {
  config: ContrailConfig;
  /** Root project directory (for finding lexicon source files). */
  rootDir: string;
  /** Directory to write generated lexicons into (will be cleaned first). Omit for in-memory only. */
  outputDir?: string;
  /** Additional lexicon source directories to search for collection schemas. */
  lexiconDirs?: string[];
  /** If true, also writes lex.config.js and queryable.generated.ts. */
  writeRuntimeFiles?: boolean;
  /** Suppress console output. */
  quiet?: boolean;
}

function fieldToParam(field: string): string {
  return field.replace(/\.(\w)/g, (_, c) => c.toUpperCase());
}

/** Locate a shipped lexicon-template subdir (`spaces`/`community`/`realtime`).
 *  Works in contrail's own repo and in downstream projects that depend on
 *  @atmo-dev/contrail. All three module templates live under one
 *  `lexicon-templates/` parent; each subdir is instantiated by the generator
 *  into its own `<ns>.*` namespace. */
function findTemplatesDir(
  rootDir: string,
  module: "spaces" | "community" | "realtime" | "invite"
): string | null {
  // Templates are shipped with @atmo-dev/contrail-lexicons. Look in the
  // user project's node_modules first, then fall back to the package's own
  // directory (for development in this monorepo, where the templates live
  // next to this file).
  const candidates = [
    join(rootDir, "lexicon-templates", module),
    join(rootDir, "node_modules/@atmo-dev/contrail-lexicons/lexicon-templates", module),
    // When running from the package's own dist/ (ESM), __dirname is unavailable;
    // rely on import.meta.url.
    new URL(`../lexicon-templates/${module}`, import.meta.url).pathname,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const findSpaceTemplatesDir = (rootDir: string) => findTemplatesDir(rootDir, "spaces");
const findCommunityTemplatesDir = (rootDir: string) => findTemplatesDir(rootDir, "community");
const findRealtimeTemplatesDir = (rootDir: string) => findTemplatesDir(rootDir, "realtime");
const findInviteTemplatesDir = (rootDir: string) => findTemplatesDir(rootDir, "invite");

/** Yield all JSON files under a directory (recursive). */
function* walkJson(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(full);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield full;
  }
}

interface QueryableField {
  type?: "range";
}

interface CountField {
  name: string;
  description: string;
}

interface RelationDef {
  relName: string;
  collection: string;
  groupBy?: string;
  groups: Record<string, string>;
}

interface ReferenceDef {
  refName: string;
  collection: string;
}

export function generateLexicons(options: GenerateOptions): Record<string, object> {
  const { config, rootDir, outputDir, quiet } = options;
  const lexiconDirs = options.lexiconDirs ?? [
    join(rootDir, "lexicons", "custom"),
    join(rootDir, "lexicons", "pulled"),
  ];

  const log = quiet ? () => {} : console.log;
  const generated: Record<string, object> = {};

  // --- Helpers that depend on lexiconDirs ---

  function findCollectionLexicon(collection: string): string | null {
    const segments = collection.split(".");
    for (const dir of lexiconDirs) {
      const filePath = join(dir, ...segments) + ".json";
      if (existsSync(filePath)) return filePath;
    }
    return null;
  }

  function getKnownValues(collection: string, fieldName: string): string[] {
    const filePath = findCollectionLexicon(collection);
    if (!filePath) return [];
    try {
      const doc = JSON.parse(readFileSync(filePath, "utf-8"));
      const props = doc.defs?.main?.record?.properties;
      if (!props) return [];
      const field = props[fieldName];
      if (!field) return [];
      if (Array.isArray(field.knownValues)) return field.knownValues;
      return [];
    } catch {
      return [];
    }
  }

  function getCollectionLexiconRef(collection: string): string | null {
    const filePath = findCollectionLexicon(collection);
    if (!filePath) return null;
    try {
      const doc = JSON.parse(readFileSync(filePath, "utf-8"));
      if (doc.defs?.main) return `${collection}#main`;
    } catch {}
    return null;
  }

  function getRecordObjectSchema(collection: string): any | null {
    const filePath = findCollectionLexicon(collection);
    if (!filePath) return null;
    try {
      const doc = JSON.parse(readFileSync(filePath, "utf-8"));
      const main = doc.defs?.main;
      if (main?.type === "record" && main.record) return main.record;
      return null;
    } catch {
      return null;
    }
  }

  // --- Writing ---

  if (outputDir) {
    rmSync(outputDir, { recursive: true, force: true });
  }

  function writeLexicon(nsid: string, doc: object) {
    if (outputDir) {
      const filePath = join(outputDir, ...nsid.split(".")) + ".json";
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n");
    }
    generated[nsid] = doc;
    log(`  ${nsid}`);
  }

  // --- Building ---

  function buildRecordDef(
    collectionRef: string | null,
    countFields?: CountField[],
    relationDefs?: RelationDef[],
    referenceDefs?: ReferenceDef[]
  ) {
    // Response shape mirrors atproto's `com.atproto.repo.listRecords#record`
    // ({ uri, cid, value }) and extends it with contrail-specific fields.
    // Required list + field name match the standard so generic atproto
    // clients can consume contrail responses without custom handling.
    const properties: Record<string, any> = {
      uri: { type: "string", format: "at-uri" },
      cid: { type: "string", format: "cid" },
      value: collectionRef ? { type: "ref", ref: collectionRef } : { type: "unknown" },
      did: { type: "string", format: "did" },
      collection: { type: "string", format: "nsid" },
      rkey: { type: "string" },
      time_us: { type: "integer" },
      ...(config.spaces
        ? {
            space: {
              type: "string",
              description: "Present when the record was read from a permissioned space; its value is the `ats://` space URI.",
            },
          }
        : {}),
    };
    if (countFields) {
      for (const cf of countFields) {
        properties[cf.name] = { type: "integer", description: cf.description };
      }
    }
    if (relationDefs && relationDefs.length > 0) {
      for (const rd of relationDefs) {
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        if (rd.groupBy && Object.keys(rd.groups).length > 0) {
          properties[rd.relName] = { type: "ref", ref: `#hydrate${cap(rd.relName)}` };
        } else {
          properties[rd.relName] = { type: "array", items: { type: "ref", ref: `#hydrate${cap(rd.relName)}Record` } };
        }
      }
    }
    if (referenceDefs && referenceDefs.length > 0) {
      for (const rd of referenceDefs) {
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        properties[rd.refName] = { type: "ref", ref: `#ref${cap(rd.refName)}Record` };
      }
    }
    // Required list is a superset of atproto's `#record` (`uri`, `cid`, `value`).
    // Contrail always populates the extras too, so including them here gives
    // contrail-aware clients strong typing without breaking atproto clients
    // that only check the standard three.
    return {
      type: "object",
      required: ["uri", "cid", "value", "did", "collection", "rkey", "time_us"],
      properties,
    };
  }

  function buildHydrateDefs(relationDefs: RelationDef[]): Record<string, any> {
    const defs: Record<string, any> = {};
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    for (const rd of relationDefs) {
      const relCollectionRef = getCollectionLexiconRef(rd.collection);
      const recordDefName = `hydrate${cap(rd.relName)}Record`;
      defs[recordDefName] = {
        type: "object",
        required: ["uri", "did", "collection", "rkey", "time_us"],
        properties: {
          uri: { type: "string", format: "at-uri" },
          did: { type: "string", format: "did" },
          collection: { type: "string", format: "nsid" },
          rkey: { type: "string" },
          cid: { type: "string" },
          record: relCollectionRef ? { type: "ref", ref: relCollectionRef } : { type: "unknown" },
          time_us: { type: "integer" },
          ...(config.spaces
            ? {
                space: {
                  type: "string",
                  description: "Present when the record was read from a permissioned space; `ats://` URI.",
                },
              }
            : {}),
        },
      };
      if (rd.groupBy && Object.keys(rd.groups).length > 0) {
        const groupDefName = `hydrate${cap(rd.relName)}`;
        const groupProperties: Record<string, any> = {};
        for (const shortName of Object.keys(rd.groups)) {
          groupProperties[shortName] = { type: "array", items: { type: "ref", ref: `#${recordDefName}` } };
        }
        groupProperties["other"] = { type: "array", items: { type: "ref", ref: `#${recordDefName}` } };
        defs[groupDefName] = { type: "object", properties: groupProperties };
      }
    }
    return defs;
  }

  function buildReferenceDefs(referenceDefs: ReferenceDef[]): Record<string, any> {
    const defs: Record<string, any> = {};
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    for (const rd of referenceDefs) {
      const refCollectionRef = getCollectionLexiconRef(rd.collection);
      const recordDefName = `ref${cap(rd.refName)}Record`;
      defs[recordDefName] = {
        type: "object",
        required: ["uri", "did", "collection", "rkey", "time_us"],
        properties: {
          uri: { type: "string", format: "at-uri" },
          did: { type: "string", format: "did" },
          collection: { type: "string", format: "nsid" },
          rkey: { type: "string" },
          cid: { type: "string" },
          record: refCollectionRef ? { type: "ref", ref: refCollectionRef } : { type: "unknown" },
          time_us: { type: "integer" },
          ...(config.spaces
            ? {
                space: {
                  type: "string",
                  description: "Present when the record was read from a permissioned space; `ats://` URI.",
                },
              }
            : {}),
        },
      };
    }
    return defs;
  }

  function profileDefs() {
    const profiles: string[] = (config.profiles ?? ["app.bsky.actor.profile"]).map(
      (p) => (typeof p === "string" ? p : p.collection)
    );
    const extraDefs: Record<string, any> = {};
    const objectRefs: string[] = [];
    for (const col of profiles) {
      const schema = getRecordObjectSchema(col);
      if (!schema) continue;
      const defName = col.split(".").map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join("");
      extraDefs[defName] = schema;
      objectRefs.push(`#${defName}`);
    }
    let valueField: any;
    if (objectRefs.length === 1) valueField = { type: "ref", ref: objectRefs[0] };
    else if (objectRefs.length > 1) valueField = { type: "union", refs: objectRefs };
    else valueField = { type: "unknown" };
    return {
      profileEntry: {
        type: "object",
        required: ["did"],
        properties: {
          did: { type: "string", format: "did" },
          handle: { type: "string" },
          uri: { type: "string", format: "at-uri" },
          cid: { type: "string", format: "cid" },
          value: valueField,
          collection: { type: "string", format: "nsid" },
          rkey: { type: "string" },
        },
      },
      ...extraDefs,
    };
  }

  function tokenShortName(token: string): string {
    const hash = token.indexOf("#");
    return hash !== -1 ? token.slice(hash + 1) : token;
  }

  // --- Generate ---

  const ns = config.namespace;

  log("Generating admin endpoints...");

  writeLexicon(`${ns}.getCursor`, {
    lexicon: 1, id: `${ns}.getCursor`,
    defs: { main: { type: "query", description: "Get the current cursor position", output: { encoding: "application/json", schema: { type: "object", properties: { time_us: { type: "integer" }, date: { type: "string" }, seconds_ago: { type: "integer" } } } } } },
  });

  writeLexicon(`${ns}.getOverview`, {
    lexicon: 1, id: `${ns}.getOverview`,
    defs: { main: { type: "query", description: "Get an overview of all indexed collections", output: { encoding: "application/json", schema: { type: "object", required: ["total_records", "collections"], properties: { total_records: { type: "integer" }, collections: { type: "array", items: { type: "ref", ref: "#collectionStats" } } } } } }, collectionStats: { type: "object", required: ["collection", "records", "unique_users"], properties: { collection: { type: "string" }, records: { type: "integer" }, unique_users: { type: "integer" } } } },
  });


  writeLexicon(`${ns}.getProfile`, {
    lexicon: 1, id: `${ns}.getProfile`,
    defs: { main: { type: "query", description: "Get a user's profiles by DID or handle", parameters: { type: "params", required: ["actor"], properties: { actor: { type: "string", format: "at-identifier", description: "DID or handle of the user" } } }, output: { encoding: "application/json", schema: { type: "object", required: ["profiles"], properties: { profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } } } } } }, ...profileDefs() },
  });

  writeLexicon(`${ns}.notifyOfUpdate`, {
    lexicon: 1, id: `${ns}.notifyOfUpdate`,
    defs: { main: { type: "procedure", description: "Notify of a record change for immediate indexing. Fetches the record from the user's PDS and indexes (or deletes) it.", input: { encoding: "application/json", schema: { type: "object", properties: { uri: { type: "string", format: "at-uri", description: "Single AT URI to fetch and index" }, uris: { type: "array", items: { type: "string", format: "at-uri" }, maxLength: 25, description: "Batch of AT URIs to fetch and index (max 25)" } } } }, output: { encoding: "application/json", schema: { type: "object", required: ["indexed", "deleted"], properties: { indexed: { type: "integer", description: "Number of records created or updated" }, deleted: { type: "integer", description: "Number of records deleted (not found on PDS)" }, errors: { type: "array", items: { type: "string" }, description: "Errors for individual URIs that could not be processed" } } } } } },
  });

  // --- Feeds ---

  if (config.feeds && Object.keys(config.feeds).length > 0) {
    log("Generating feed endpoint...");

    const feedNames = Object.keys(config.feeds);
    // feedConfig.targets are short names; expose NSIDs in the lexicon since the
    // `collection` param filters by the record's NSID at the wire level.
    const allTargets = [...new Set(Object.values(config.feeds).flatMap((f) => f.targets))];
    const allTargetNsids = allTargets
      .map((t) => config.collections[t]?.collection)
      .filter((n): n is string => !!n);

    const feedParams: Record<string, any> = {
      feed: { type: "string", knownValues: feedNames, description: "Feed name" },
      actor: { type: "string", format: "at-identifier", description: "DID or handle of the requesting user" },
      collection: { type: "string", knownValues: allTargetNsids, description: "Filter by target collection (defaults to first target)" },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      cursor: { type: "string" },
      profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
    };

    const feedSortableValues: string[] = [];
    const feedHydrateDefs: Record<string, any> = {};
    const feedRefDefs: Record<string, any> = {};
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    for (const targetCol of allTargets) {
      const targetConfig = config.collections[targetCol];
      if (!targetConfig) continue;
      const targetNsid = targetConfig.collection;

      const merged = targetConfig.queryable ?? {};

      // Search
      if (Array.isArray(targetConfig.searchable) && targetConfig.searchable.length > 0 && !feedParams["search"]) {
        feedParams["search"] = { type: "string", description: "Full-text search" };
      }

      // Queryable fields
      for (const [field, fieldConfig] of Object.entries(merged)) {
        const param = fieldToParam(field);
        if (fieldConfig.type === "range") {
          if (!feedParams[`${param}Min`]) {
            feedParams[`${param}Min`] = { type: "string", description: `Minimum value for ${field}` };
            feedParams[`${param}Max`] = { type: "string", description: `Maximum value for ${field}` };
          }
        } else {
          if (!feedParams[param]) {
            feedParams[param] = { type: "string", description: `Filter by ${field}` };
          }
        }
        feedSortableValues.push(fieldToParam(field));
      }

      // Relations (counts + hydration)
      for (const [relName, rel] of Object.entries(targetConfig.relations ?? {})) {
        if (!feedParams[`${relName}CountMin`]) {
          feedParams[`${relName}CountMin`] = { type: "integer", description: `Minimum total ${relName} count` };
          feedSortableValues.push(`${relName}Count`);
        }
        if (!feedParams[`hydrate${cap(relName)}`]) {
          feedParams[`hydrate${cap(relName)}`] = { type: "integer", minimum: 1, maximum: 50, description: `Number of ${relName} records to embed per record` };
        }

        if (rel.groupBy) {
          const relNsid = config.collections[rel.collection]?.collection ?? rel.collection;
          const knownValues = getKnownValues(relNsid, rel.groupBy);
          for (const token of knownValues) {
            const gShort = tokenShortName(token);
            const paramName = `${relName}${cap(gShort)}CountMin`;
            if (!feedParams[paramName]) {
              feedParams[paramName] = { type: "integer", description: `Minimum ${relName} count where ${rel.groupBy} = ${gShort}` };
              feedSortableValues.push(`${relName}${cap(gShort)}Count`);
            }
          }
        }
      }

      // References (hydration params)
      for (const [refName] of Object.entries(targetConfig.references ?? {})) {
        if (!feedParams[`hydrate${cap(refName)}`]) {
          feedParams[`hydrate${cap(refName)}`] = { type: "boolean", description: `Embed the referenced ${refName} record` };
        }
      }
    }

    // Sort/order params
    const uniqueSortable = [...new Set(feedSortableValues)];
    if (uniqueSortable.length > 0) {
      feedParams["sort"] = { type: "string", knownValues: uniqueSortable, description: "Field to sort by (default: time_us)" };
      feedParams["order"] = { type: "string", knownValues: ["asc", "desc"], description: "Sort direction" };
    }

    // Build a record def per target collection for the union
    const feedRecordDefs: Record<string, any> = {};
    const feedRecordRefs: string[] = [];

    for (const targetCol of allTargets) {
      const targetConfig = config.collections[targetCol];
      if (!targetConfig) continue;
      const targetNsid = targetConfig.collection;

      const collectionRef = getCollectionLexiconRef(targetNsid);

      const countFields: CountField[] = [];
      const relationDefs: RelationDef[] = [];
      const referenceDefs: ReferenceDef[] = [];

      for (const [relName, rel] of Object.entries(targetConfig.relations ?? {})) {
        countFields.push({ name: `${relName}Count`, description: `Total ${relName} count` });
        const relNsid = config.collections[rel.collection]?.collection ?? rel.collection;
        const groupMapping: Record<string, string> = {};
        if (rel.groupBy) {
          for (const token of getKnownValues(relNsid, rel.groupBy)) {
            const gShort = tokenShortName(token);
            groupMapping[gShort] = token;
            countFields.push({ name: `${relName}${cap(gShort)}Count`, description: `${relName} count where ${rel.groupBy} = ${gShort}` });
          }
        }
        relationDefs.push({ relName, collection: relNsid, groupBy: rel.groupBy, groups: groupMapping });
      }

      for (const [refName, ref] of Object.entries(targetConfig.references ?? {})) {
        const refNsid = config.collections[ref.collection]?.collection ?? ref.collection;
        referenceDefs.push({ refName, collection: refNsid });
      }

      const defName = `feedRecord_${targetCol.replace(/[^a-zA-Z0-9]/g, "_")}`;
      feedRecordDefs[defName] = buildRecordDef(collectionRef, countFields, relationDefs, referenceDefs);
      feedRecordRefs.push(`#${defName}`);

      // Add hydrate + reference defs (includes grouped wrappers)
      Object.assign(feedHydrateDefs, buildHydrateDefs(relationDefs));
      Object.assign(feedRefDefs, buildReferenceDefs(referenceDefs));
    }

    const recordsItems = feedRecordRefs.length === 1
      ? { type: "ref", ref: feedRecordRefs[0] }
      : { type: "union", refs: feedRecordRefs };

    writeLexicon(`${ns}.getFeed`, {
      lexicon: 1, id: `${ns}.getFeed`,
      defs: {
        main: {
          type: "query",
          description: "Get a personalized feed based on followed users' activity",
          parameters: { type: "params", required: ["feed", "actor"], properties: feedParams },
          output: {
            encoding: "application/json",
            schema: {
              type: "object",
              required: ["records"],
              properties: {
                records: { type: "array", items: recordsItems },
                cursor: { type: "string" },
                profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } },
              },
            },
          },
        },
        ...feedRecordDefs,
        ...feedHydrateDefs,
        ...feedRefDefs,
        ...profileDefs(),
      },
    });
  }

  // --- Per-collection ---

  log("Generating collection endpoints...");

  const resolvedQueryableMap: Record<string, Record<string, { type?: "range" }>> = {};
  const resolvedRelationsMap: Record<string, Record<string, { collection: string; groupBy: string; groups: Record<string, string> }>> = {};

  for (const [shortName, colConfig] of Object.entries(config.collections)) {
    const collection = colConfig.collection; // full NSID for lexicon refs
    const collectionRef = getCollectionLexiconRef(collection);

    const merged = colConfig.queryable ?? {};
    resolvedQueryableMap[shortName] = merged;

    // --- listRecords ---
    const listParams: Record<string, any> = {
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      cursor: { type: "string" },
      actor: { type: "string", format: "at-identifier", description: "Filter by DID or handle (triggers on-demand backfill)" },
      profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
      ...(config.spaces
        ? {
            spaceUri: {
              type: "string",
              description: "If set, query records inside this permissioned space (requires service-auth JWT or a read-grant invite token). `ats://` URI.",
            },
            byUser: {
              type: "string",
              format: "did",
              description: "Only used with spaceUri — filter to records authored by this DID.",
            },
            inviteToken: {
              type: "string",
              description: "Read-grant invite token for anonymous bearer access. Replaces JWT auth when supplied.",
            },
          }
        : {}),
    };

    // Search param
    if (Array.isArray(colConfig.searchable) && colConfig.searchable.length > 0) {
      listParams["search"] = {
        type: "string",
        description: `Full-text search across: ${colConfig.searchable.join(", ")}`,
      };
    }

    for (const [field, fieldConfig] of Object.entries(merged)) {
      const param = fieldToParam(field);
      if (fieldConfig.type === "range") {
        listParams[`${param}Min`] = { type: "string", description: `Minimum value for ${field}` };
        listParams[`${param}Max`] = { type: "string", description: `Maximum value for ${field}` };
      } else {
        listParams[param] = { type: "string", description: `Filter by ${field}` };
      }
    }

    const countFields: CountField[] = [];
    const relationDefs: RelationDef[] = [];
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      countFields.push({ name: `${relName}Count`, description: `Total ${relName} count` });
      listParams[`${relName}CountMin`] = { type: "integer", description: `Minimum total ${relName} count` };
      listParams[`hydrate${cap(relName)}`] = { type: "integer", minimum: 1, maximum: 50, description: `Number of ${relName} records to embed per record` };

      const relNsid = config.collections[rel.collection]?.collection ?? rel.collection;
      const groupMapping: Record<string, string> = {};
      if (rel.groupBy) {
        const knownValues = getKnownValues(relNsid, rel.groupBy);
        for (const token of knownValues) {
          const gShort = tokenShortName(token);
          groupMapping[gShort] = token;
          countFields.push({ name: `${relName}${cap(gShort)}Count`, description: `${relName} count where ${rel.groupBy} = ${gShort}` });
          listParams[`${relName}${cap(gShort)}CountMin`] = { type: "integer", description: `Minimum ${relName} count where ${rel.groupBy} = ${gShort}` };
        }
        if (!resolvedRelationsMap[shortName]) resolvedRelationsMap[shortName] = {};
        resolvedRelationsMap[shortName][relName] = { collection: rel.collection, groupBy: rel.groupBy, groups: groupMapping };
      }

      relationDefs.push({ relName, collection: relNsid, groupBy: rel.groupBy, groups: groupMapping });
    }

    const referenceDefs: ReferenceDef[] = [];
    for (const [refName, ref] of Object.entries(colConfig.references ?? {})) {
      const refNsid = config.collections[ref.collection]?.collection ?? ref.collection;
      referenceDefs.push({ refName, collection: refNsid });
    }
    for (const refName of Object.keys(colConfig.references ?? {})) {
      listParams[`hydrate${cap(refName)}`] = { type: "boolean", description: `Embed the referenced ${refName} record` };
    }

    const sortableValues: string[] = [];
    for (const field of Object.keys(merged)) sortableValues.push(fieldToParam(field));
    for (const cf of countFields) sortableValues.push(cf.name);
    if (sortableValues.length > 0) {
      listParams["sort"] = { type: "string", knownValues: sortableValues, description: "Field to sort by (default: time_us)" };
      listParams["order"] = { type: "string", knownValues: ["asc", "desc"], description: "Sort direction (default: desc for dates/numbers/counts, asc for strings)" };
    }

    const hydrateDefs = buildHydrateDefs(relationDefs);
    const refDefs = buildReferenceDefs(referenceDefs);

    const methods = colConfig.methods ?? ["listRecords", "getRecord"];
    if (methods.includes("listRecords")) {
      writeLexicon(`${ns}.${shortName}.listRecords`, {
        lexicon: 1, id: `${ns}.${shortName}.listRecords`,
        defs: {
          main: { type: "query", description: `Query ${collection} records with filters`, parameters: { type: "params", properties: listParams }, output: { encoding: "application/json", schema: { type: "object", required: ["records"], properties: { records: { type: "array", items: { type: "ref", ref: "#record" } }, cursor: { type: "string" }, profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } } } } } },
          record: buildRecordDef(collectionRef, countFields, relationDefs, referenceDefs),
          ...hydrateDefs, ...refDefs, ...profileDefs(),
        },
      });

      // watchRecords — realtime subscription over the same query shape.
      // Only emitted when realtime is configured. SSE-only (subscription
      // lexicon doesn't cleanly model custom event framing, so we describe it
      // as a query with a streaming output and document the event kinds.)
      if (config.realtime) {
        writeLexicon(`${ns}.${shortName}.watchRecords`, {
          lexicon: 1,
          id: `${ns}.${shortName}.watchRecords`,
          defs: {
            main: {
              type: "query",
              description:
                `Subscribe to a live ${collection} query. Returns Server-Sent Events: ` +
                `\`snapshot.start\`, \`snapshot.record\` (N of), \`snapshot.end\`, ` +
                `then \`record.created\` / \`record.deleted\` as records enter/leave the result, ` +
                `plus a final \`member.removed\` if the caller loses access mid-stream. ` +
                `v1 requires spaceUri; cross-space watch is deferred.`,
              parameters: { type: "params", properties: listParams },
              output: {
                encoding: "text/event-stream",
                schema: { type: "object", properties: {} },
              },
              errors: [
                { name: "InvalidRequest" },
                { name: "AuthRequired" },
                { name: "Forbidden" },
                { name: "NotFound" },
                { name: "NotSupported" },
              ],
            },
          },
        });
      }
    }

    // --- getRecord ---
    const getParams: Record<string, any> = {
      uri: { type: "string", format: "at-uri", description: "AT URI of the record" },
      profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
      ...(config.spaces
        ? {
            spaceUri: {
              type: "string",
              description: "If set, fetch from this permissioned space (requires service-auth JWT or a read-grant invite token). `ats://` URI.",
            },
            inviteToken: {
              type: "string",
              description: "Read-grant invite token for anonymous bearer access. Replaces JWT auth when supplied.",
            },
          }
        : {}),
    };
    for (const rd of relationDefs) {
      getParams[`hydrate${cap(rd.relName)}`] = { type: "integer", minimum: 1, maximum: 50, description: `Number of ${rd.relName} records to embed` };
    }
    for (const refName of Object.keys(colConfig.references ?? {})) {
      getParams[`hydrate${cap(refName)}`] = { type: "boolean", description: `Embed the referenced ${refName} record` };
    }

    if (methods.includes("getRecord")) {
      writeLexicon(`${ns}.${shortName}.getRecord`, {
        lexicon: 1, id: `${ns}.${shortName}.getRecord`,
        defs: {
          main: { type: "query", description: `Get a single ${collection} record by AT URI`, parameters: { type: "params", required: ["uri"], properties: getParams }, output: { encoding: "application/json", schema: { type: "object", required: ["uri", "value", "did", "collection", "rkey", "time_us"], properties: { ...buildRecordDef(collectionRef, countFields, relationDefs, referenceDefs).properties, profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } } } } } },
          ...hydrateDefs, ...refDefs, ...profileDefs(),
        },
      });
    }

    for (const queryName of Object.keys(colConfig.queries ?? {})) {
      writeLexicon(`${ns}.${shortName}.${queryName}`, {
        lexicon: 1, id: `${ns}.${shortName}.${queryName}`,
        defs: { main: { type: "query", description: `Custom query: ${queryName}`, output: { encoding: "application/json", schema: { type: "object", properties: {} } } } },
      });
    }
  }

  // --- Spaces: instantiate library templates under <ns>.space.* and
  //     <ns>.spaceExt.* (contrail-specific extras — invites, whoami).
  //     Splitting the namespace keeps the `space.*` surface aligned with the
  //     permissioned-data spec; extras move when the spec does not. ---

  if (config.spaces) {
    log("Generating space endpoints...");
    const templatesDir = findSpaceTemplatesDir(rootDir);
    if (!templatesDir) {
      log("  (space templates not found — skipping)");
    } else {
      // Order matters: more specific prefix first so `spaceExt` isn't matched
      // by the `space` rule.
      const prefixes: Array<[string, string]> = [
        ["tools.atmo.spaceExt", `${ns}.spaceExt`],
        ["tools.atmo.space", `${ns}.space`],
      ];
      const templateIdRe = /^tools\.atmo\.space(Ext)?(\.[A-Za-z0-9.]+)?$/;
      const idReplace = (id: string) => {
        for (const [from, to] of prefixes) {
          if (id === from || id.startsWith(from + ".")) {
            return to + id.slice(from.length);
          }
        }
        return id;
      };

      const rewriteRefs = (obj: any): any => {
        if (Array.isArray(obj)) return obj.map(rewriteRefs);
        if (obj && typeof obj === "object") {
          const out: any = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === "ref" && typeof v === "string") {
              out[k] = idReplace(v);
            } else if (k === "id" && typeof v === "string" && templateIdRe.test(v)) {
              out[k] = idReplace(v);
            } else {
              out[k] = rewriteRefs(v);
            }
          }
          return out;
        }
        return obj;
      };

      for (const file of walkJson(templatesDir)) {
        const doc = JSON.parse(readFileSync(file, "utf-8"));
        if (typeof doc.id !== "string" || !templateIdRe.test(doc.id)) continue;
        const newId = idReplace(doc.id);
        const rewritten = rewriteRefs({ ...doc, id: newId });
        writeLexicon(newId, rewritten);
      }
    }
  }

  // --- Community: instantiate library templates under <ns>.community.* ---

  if (config.community) {
    log("Generating community endpoints...");
    const templatesDir = findCommunityTemplatesDir(rootDir);
    if (!templatesDir) {
      log("  (community templates not found — skipping)");
    } else {
      const templateIdRe = /^tools\.atmo\.community(\.[A-Za-z0-9.]+)?$/;
      const idReplace = (id: string) =>
        id.startsWith("tools.atmo.community")
          ? id.replace(/^tools\.atmo\.community/, `${ns}.community`)
          : id;

      const rewriteRefs = (obj: any): any => {
        if (Array.isArray(obj)) return obj.map(rewriteRefs);
        if (obj && typeof obj === "object") {
          const out: any = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === "ref" && typeof v === "string" && v.startsWith("tools.atmo.community")) {
              out[k] = v.replace(/^tools\.atmo\.community/, `${ns}.community`);
            } else if (k === "id" && typeof v === "string" && templateIdRe.test(v)) {
              out[k] = idReplace(v);
            } else {
              out[k] = rewriteRefs(v);
            }
          }
          return out;
        }
        return obj;
      };

      for (const file of walkJson(templatesDir)) {
        const doc = JSON.parse(readFileSync(file, "utf-8"));
        if (typeof doc.id !== "string" || !templateIdRe.test(doc.id)) continue;
        const newId = idReplace(doc.id);
        const rewritten = rewriteRefs({ ...doc, id: newId });
        writeLexicon(newId, rewritten);
      }
    }
  }

  // --- Realtime: instantiate library templates under <ns>.realtime.* ---

  if (config.realtime) {
    log("Generating realtime endpoints...");
    const templatesDir = findRealtimeTemplatesDir(rootDir);
    if (!templatesDir) {
      log("  (realtime templates not found — skipping)");
    } else {
      const templateIdRe = /^tools\.atmo\.realtime(\.[A-Za-z0-9.]+)?$/;
      const idReplace = (id: string) =>
        id.startsWith("tools.atmo.realtime")
          ? id.replace(/^tools\.atmo\.realtime/, `${ns}.realtime`)
          : id;

      const rewriteRefs = (obj: any): any => {
        if (Array.isArray(obj)) return obj.map(rewriteRefs);
        if (obj && typeof obj === "object") {
          const out: any = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === "ref" && typeof v === "string" && v.startsWith("tools.atmo.realtime")) {
              out[k] = v.replace(/^tools\.atmo\.realtime/, `${ns}.realtime`);
            } else if (k === "id" && typeof v === "string" && templateIdRe.test(v)) {
              out[k] = idReplace(v);
            } else {
              out[k] = rewriteRefs(v);
            }
          }
          return out;
        }
        return obj;
      };

      for (const file of walkJson(templatesDir)) {
        const doc = JSON.parse(readFileSync(file, "utf-8"));
        if (typeof doc.id !== "string" || !templateIdRe.test(doc.id)) continue;
        const newId = idReplace(doc.id);
        const rewritten = rewriteRefs({ ...doc, id: newId });
        writeLexicon(newId, rewritten);
      }
    }
  }

  // --- Invites: a single <ns>.invite.* family that dispatches on space
  //     ownership. Emitted whenever spaces is configured (user-owned spaces
  //     can always issue invites); community-owned spaces add the
  //     `accessLevel` branch inside the same handlers. ---

  if (config.spaces) {
    log("Generating invite endpoints...");
    const templatesDir = findInviteTemplatesDir(rootDir);
    if (!templatesDir) {
      log("  (invite templates not found — skipping)");
    } else {
      const templateIdRe = /^tools\.atmo\.invite(\.[A-Za-z0-9.]+)?$/;
      const idReplace = (id: string) =>
        id.startsWith("tools.atmo.invite")
          ? id.replace(/^tools\.atmo\.invite/, `${ns}.invite`)
          : id;

      const rewriteRefs = (obj: any): any => {
        if (Array.isArray(obj)) return obj.map(rewriteRefs);
        if (obj && typeof obj === "object") {
          const out: any = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === "ref" && typeof v === "string" && v.startsWith("tools.atmo.invite")) {
              out[k] = v.replace(/^tools\.atmo\.invite/, `${ns}.invite`);
            } else if (k === "id" && typeof v === "string" && templateIdRe.test(v)) {
              out[k] = idReplace(v);
            } else {
              out[k] = rewriteRefs(v);
            }
          }
          return out;
        }
        return obj;
      };

      for (const file of walkJson(templatesDir)) {
        const doc = JSON.parse(readFileSync(file, "utf-8"));
        if (typeof doc.id !== "string" || !templateIdRe.test(doc.id)) continue;
        const newId = idReplace(doc.id);
        const rewritten = rewriteRefs({ ...doc, id: newId });
        writeLexicon(newId, rewritten);
      }
    }
  }

  // --- Permission set ---
  // Permission-set lexicons (https://atproto.com/guides/permission-sets) can
  // only reference NSIDs under the same namespace as the set itself, which
  // matches what we emit here: everything under `<ns>.*`.

  {
    log("Generating permission set...");
    const methodNsids: string[] = [];
    for (const [nsid, doc] of Object.entries(generated)) {
      const mainType = (doc as any)?.defs?.main?.type;
      if (mainType === "query" || mainType === "procedure") {
        methodNsids.push(nsid);
      }
    }
    methodNsids.sort();

    const psConfig = config.permissionSet ?? {};

    // Permission-set lexicons can only reference NSIDs under their own namespace.
    // Validate `additional` entries before we emit and produce an invalid schema.
    const nsPrefix = `${ns}.`;
    for (const [i, perm] of (psConfig.additional ?? []).entries()) {
      const p = perm as { resource?: string; lxm?: string[]; collection?: string[] };
      const offending: string[] = [];
      for (const nsid of p.lxm ?? []) {
        if (nsid !== ns && !nsid.startsWith(nsPrefix)) offending.push(nsid);
      }
      for (const nsid of p.collection ?? []) {
        if (nsid !== ns && !nsid.startsWith(nsPrefix)) offending.push(nsid);
      }
      if (offending.length > 0) {
        throw new Error(
          `permissionSet.additional[${i}] (${p.resource}) references NSIDs outside '${ns}': ` +
            offending.join(", ") +
            `. Permission-set lexicons can only reference NSIDs in their own namespace — ` +
            `declare those as standalone scopes in your OAuth client config instead.`
        );
      }
    }

    writeLexicon(`${ns}.permissionSet`, {
      lexicon: 1,
      id: `${ns}.permissionSet`,
      defs: {
        main: {
          type: "permission-set",
          title: psConfig.title ?? ns,
          description:
            psConfig.description ?? `All XRPC methods exposed by the ${ns} service.`,
          permissions: [
            {
              type: "permission",
              resource: "rpc",
              // `aud: "*"` grants the user consent to call these methods on
              // *any* service DID — so one consent covers dev (tunnel DID) and
              // prod (published DID) without re-consenting. `inheritAud: true`
              // would be correct if the include: scope carried an aud param,
              // but consent UIs drop `?aud=*` on include: lines in practice.
              aud: "*",
              lxm: methodNsids,
            },
            ...(psConfig.additional ?? []),
          ],
        },
      },
    });
  }

  // --- Runtime files (only when called from script) ---
  if (options.writeRuntimeFiles) {
    // lex.config.js
    const collectionNsids = Object.values(config.collections).map((c) => c.collection);
    const pulledFiles = [...scanLexiconsDir(lexiconDirs), ...scanLexiconsDir([])].flat();
    const allRefs = new Set<string>();
    for (const file of pulledFiles) {
      for (const ref of findRefsInLexicon(file)) allRefs.add(ref);
    }
    const profileNsids: string[] = (config.profiles ?? ["app.bsky.actor.profile"]).map(
      (p) => (typeof p === "string" ? p : p.collection)
    );
    const feedFollowNsids = config.feeds ? Object.values(config.feeds).map((f) => f.follow) : [];
    const pullNsids = new Set([...collectionNsids, ...profileNsids, ...feedFollowNsids]);
    for (const ref of allRefs) {
      if (!ref.startsWith("com.atproto.")) pullNsids.add(ref);
    }
    const sortedNsids = [...pullNsids].sort();
    const lexConfigContent = `import { defineLexiconConfig } from "@atcute/lex-cli";\n\nexport default defineLexiconConfig({\n  files: ["lexicons/custom/**/*.json", "lexicons/pulled/**/*.json", "lexicons/generated/**/*.json"],\n  outdir: "src/lexicon-types/",\n  imports: ["@atcute/atproto"],\n  pull: {\n    outdir: "lexicons/pulled/",\n    sources: [\n      {\n        type: "atproto",\n        mode: "nsids",\n        nsids: ${JSON.stringify(sortedNsids, null, 10).replace(/^/gm, "        ").trim()},\n      },\n    ],\n  },\n});\n`;
    writeFileSync(join(rootDir, "lex.config.js"), lexConfigContent);
    log(`\nGenerated lex.config.js with ${sortedNsids.length} pull NSIDs`);

  }

  // --- Bundle manifest ---
  // Emit `index.ts` alongside the generated JSONs, importing every lexicon
  // this deployment speaks: generated + pulled + custom. Consumers pass it
  // to `createWorker(config, { lexicons })` to expose the full set at
  // `/xrpc/<ns>.lexicons` — the pulled ones are needed so consumer typegen
  // can resolve `$ref`s from the generated schemas.
  if (outputDir) {
    const paths = new Set<string>();

    // Generated JSONs live in outputDir itself.
    for (const nsid of Object.keys(generated)) {
      paths.add("./" + nsid.split(".").join("/") + ".json");
    }

    // Pulled + custom JSONs live in the configured lexiconDirs (outside outputDir).
    for (const dir of lexiconDirs) {
      if (!existsSync(dir)) continue;
      for (const file of walkJson(dir)) {
        let rel = relative(outputDir, file);
        if (!rel.startsWith(".")) rel = "./" + rel;
        paths.add(rel);
      }
    }

    const sorted = [...paths].sort();
    const imports = sorted.map((p, i) => `import _${i} from "${p}";`).join("\n");
    const exportArray = `export const lexicons: object[] = [${sorted.map((_, i) => `_${i}`).join(", ")}];\n`;
    const header =
      "// Auto-generated by @atmo-dev/contrail-lexicons. Do not edit.\n" +
      "// Pass `lexicons` to `createWorker(config, { lexicons })` to expose them\n" +
      "// at `/xrpc/<namespace>.lexicons` for consumer apps to typegen against.\n\n";
    writeFileSync(join(outputDir, "index.ts"), header + imports + "\n\n" + exportArray);
  }

  log("\nDone!");
  return generated;
}

// --- Helpers used by writeRuntimeFiles ---

function scanLexiconsDir(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...scanLexiconsDir([fullPath]));
      else if (entry.name.endsWith(".json")) files.push(fullPath);
    }
  }
  return files;
}

function findRefsInLexicon(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const refs: string[] = [];
    const refPattern = /"ref":\s*"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)(?:#\w+)?"/g;
    let match;
    while ((match = refPattern.exec(content)) !== null) refs.push(match[1]);
    const refsArrayPattern = /"refs":\s*\[([^\]]+)\]/g;
    while ((match = refsArrayPattern.exec(content)) !== null) {
      const inner = match[1];
      const nsidPattern = /"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)(?:#\w+)?"/g;
      let innerMatch;
      while ((innerMatch = nsidPattern.exec(inner)) !== null) refs.push(innerMatch[1]);
    }
    return refs;
  } catch {
    return [];
  }
}
