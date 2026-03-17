/**
 * Generates lexicon TypeScript files from the Contrail config.
 *
 * For each collection, generates:
 *   - {nsid}.listRecords  — query with queryable field params
 *   - {nsid}.getUsers    — query with limit/cursor
 *   - {nsid}.getStats    — query returning collection stats
 *
 * Plus namespaced endpoints:
 *   - {namespace}.admin.getCursor
 *   - {namespace}.admin.getOverview
 *   - {namespace}.admin.sync
 *   - {namespace}.admin.reset
 *   - {namespace}.getProfile
 *
 * Usage: npx tsx scripts/generate-lexicons.ts
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { config } from "../src/config";

const ROOT_DIR = join(__dirname, "..");
const USER_LEXICONS_DIR = join(ROOT_DIR, "lexicons");
const PULLED_LEXICONS_DIR = join(ROOT_DIR, "lexicons-pulled");
const GENERATED_DIR = join(ROOT_DIR, "lexicons-generated");

function fieldToParam(field: string): string {
  return field.replace(/\.(\w)/g, (_, c) => c.toUpperCase());
}

interface QueryableField {
  type?: "range";
}

// Find a collection's lexicon file (user-provided takes priority over pulled)
function findCollectionLexicon(collection: string): string | null {
  const segments = collection.split(".");
  for (const dir of [USER_LEXICONS_DIR, PULLED_LEXICONS_DIR]) {
    const filePath = join(dir, ...segments) + ".json";
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

// Analyze a collection's lexicon and return auto-detected queryable fields
function detectQueryableFields(collection: string): Record<string, QueryableField> {
  const filePath = findCollectionLexicon(collection);
  if (!filePath) return {};
  try {
    const doc = JSON.parse(readFileSync(filePath, "utf-8"));
    const mainRecord = doc.defs?.main?.record;
    if (!mainRecord?.properties) return {};
    return analyzeProperties(doc.defs, mainRecord.properties, "");
  } catch {
    return {};
  }
}

function analyzeProperties(
  defs: Record<string, any>,
  properties: Record<string, any>,
  prefix: string
): Record<string, QueryableField> {
  const result: Record<string, QueryableField> = {};

  for (const [field, def] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${field}` : field;

    if (def.type === "string") {
      if (def.format === "datetime") {
        result[path] = { type: "range" };
      } else if (def.format !== "uri" && def.format !== "at-uri") {
        // Regular strings (enums, free text) → equality
        result[path] = {};
      }
    } else if (def.type === "integer" || def.type === "number") {
      result[path] = { type: "range" };
    } else if (def.type === "ref" && def.ref === "com.atproto.repo.strongRef") {
      result[`${path}.uri`] = {};
    } else if (def.type === "union" && Array.isArray(def.refs) && def.refs.includes("com.atproto.repo.strongRef")) {
      result[`${path}.uri`] = {};
    } else if (def.type === "ref" && def.ref) {
      // Resolve local ref (e.g. #mode → defs.mode)
      const refId = def.ref.includes("#") ? def.ref.split("#")[1] : null;
      if (refId && defs[refId]) {
        const resolved = defs[refId];
        if (resolved.type === "string") {
          // String enum (knownValues) → equality
          result[path] = {};
        }
      }
    }
  }

  return result;
}

// Extract knownValues for a field from a collection's lexicon
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

// Default mapping: "community.lexicon.calendar.rsvp#going" → "going"
function tokenShortName(token: string): string {
  const hash = token.indexOf("#");
  return hash !== -1 ? token.slice(hash + 1) : token;
}

// Clean generated dir (user-provided lexicons/ is untouched)
rmSync(GENERATED_DIR, { recursive: true, force: true });

function nsidToPath(nsid: string): string {
  return join(GENERATED_DIR, ...nsid.split(".")) + ".json";
}

// Check if a collection lexicon exists (user-provided or pulled)
function getCollectionLexiconRef(collection: string): string | null {
  const filePath = findCollectionLexicon(collection);
  if (!filePath) return null;
  try {
    const doc = JSON.parse(readFileSync(filePath, "utf-8"));
    if (doc.defs?.main) return `${collection}#main`;
  } catch {}
  return null;
}

function ensureDir(filePath: string) {
  mkdirSync(join(filePath, ".."), { recursive: true });
}

function writeLexicon(nsid: string, doc: object) {
  const filePath = nsidToPath(nsid);
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  ${nsid}`);
}

// Build record output shape, optionally typing the record field
// countFields: e.g. [{ name: "rsvpsTotal", description: "..." }, { name: "rsvpsGoing", ... }]
interface CountField {
  name: string;
  description: string;
}

interface RelationDef {
  relName: string;
  collection: string;
  groupBy?: string;
  groups: Record<string, string>; // shortName → full token
}

function buildRecordDef(
  collectionRef: string | null,
  countFields?: CountField[],
  relationDefs?: RelationDef[]
) {
  const properties: Record<string, any> = {
    uri: { type: "string", format: "at-uri" },
    did: { type: "string", format: "did" },
    collection: { type: "string", format: "nsid" },
    rkey: { type: "string" },
    cid: { type: "string" },
    record: collectionRef
      ? { type: "ref", ref: collectionRef }
      : { type: "unknown" },
    time_us: { type: "integer" },
  };

  if (countFields) {
    for (const cf of countFields) {
      properties[cf.name] = { type: "integer", description: cf.description };
    }
  }

  if (relationDefs && relationDefs.length > 0) {
    for (const rd of relationDefs) {
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      if (rd.groupBy && Object.keys(rd.groups).length > 0) {
        properties[rd.relName] = {
          type: "ref",
          ref: `#hydrate${capitalize(rd.relName)}`,
        };
      } else {
        properties[rd.relName] = {
          type: "array",
          items: { type: "ref", ref: `#hydrate${capitalize(rd.relName)}Record` },
        };
      }
    }
  }

  return {
    type: "object",
    required: ["uri", "did", "collection", "rkey", "time_us"],
    properties,
  };
}

function buildHydrateDefs(relationDefs: RelationDef[]): Record<string, any> {
  const defs: Record<string, any> = {};
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  for (const rd of relationDefs) {
    const relCollectionRef = getCollectionLexiconRef(rd.collection);

    // Def for each hydrated record
    const recordDefName = `hydrate${capitalize(rd.relName)}Record`;
    defs[recordDefName] = {
      type: "object",
      required: ["uri", "did", "collection", "rkey", "time_us"],
      properties: {
        uri: { type: "string", format: "at-uri" },
        did: { type: "string", format: "did" },
        collection: { type: "string", format: "nsid" },
        rkey: { type: "string" },
        cid: { type: "string" },
        record: relCollectionRef
          ? { type: "ref", ref: relCollectionRef }
          : { type: "unknown" },
        time_us: { type: "integer" },
      },
    };

    if (rd.groupBy && Object.keys(rd.groups).length > 0) {
      // Grouped relation: object with group keys
      const groupDefName = `hydrate${capitalize(rd.relName)}`;
      const groupProperties: Record<string, any> = {};
      for (const shortName of Object.keys(rd.groups)) {
        groupProperties[shortName] = {
          type: "array",
          items: { type: "ref", ref: `#${recordDefName}` },
        };
      }
      groupProperties["other"] = {
        type: "array",
        items: { type: "ref", ref: `#${recordDefName}` },
      };
      defs[groupDefName] = {
        type: "object",
        properties: groupProperties,
      };
    }
    // Ungrouped relations are typed directly as arrays on the record (no wrapper def needed)
  }

  return defs;
}

// Read the inner record object schema from a collection's lexicon
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

function profileDefs() {
  const profiles = config.profiles ?? ["app.bsky.actor.profile"];
  const extraDefs: Record<string, any> = {};
  const objectRefs: string[] = [];

  for (const col of profiles) {
    const schema = getRecordObjectSchema(col);
    if (!schema) continue;
    // Create a local def name from the NSID, e.g. "app.bsky.actor.profile" → "appBskyActorProfile"
    const defName = col.split(".").map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join("");
    extraDefs[defName] = schema;
    objectRefs.push(`#${defName}`);
  }

  let recordField: any;
  if (objectRefs.length === 1) {
    recordField = { type: "ref", ref: objectRefs[0] };
  } else if (objectRefs.length > 1) {
    recordField = { type: "union", refs: objectRefs };
  } else {
    recordField = { type: "unknown" };
  }

  return {
    profileEntry: {
      type: "object",
      required: ["did"],
      properties: {
        did: { type: "string", format: "did" },
        handle: { type: "string" },
        uri: { type: "string", format: "at-uri" },
        collection: { type: "string", format: "nsid" },
        rkey: { type: "string" },
        cid: { type: "string" },
        record: recordField,
      },
    },
    ...extraDefs,
  };
}

// --- Namespace ---

const ns = config.namespace!;

// --- Admin endpoints ---

console.log("Generating admin endpoints...");

writeLexicon(`${ns}.admin.getCursor`, {
  lexicon: 1,
  id: `${ns}.admin.getCursor`,
  defs: {
    main: {
      type: "query",
      description: "Get the current cursor position",
      output: {
        encoding: "application/json",
        schema: {
          type: "object",
          properties: {
            time_us: { type: "integer" },
            date: { type: "string" },
            seconds_ago: { type: "integer" },
          },
        },
      },
    },
  },
});

writeLexicon(`${ns}.admin.getOverview`, {
  lexicon: 1,
  id: `${ns}.admin.getOverview`,
  defs: {
    main: {
      type: "query",
      description: "Get an overview of all indexed collections",
      output: {
        encoding: "application/json",
        schema: {
          type: "object",
          required: ["total_records", "collections"],
          properties: {
            total_records: { type: "integer" },
            collections: {
              type: "array",
              items: { type: "ref", ref: "#collectionStats" },
            },
          },
        },
      },
    },
    collectionStats: {
      type: "object",
      required: ["collection", "records", "unique_users"],
      properties: {
        collection: { type: "string" },
        records: { type: "integer" },
        unique_users: { type: "integer" },
      },
    },
  },
});

writeLexicon(`${ns}.admin.sync`, {
  lexicon: 1,
  id: `${ns}.admin.sync`,
  defs: {
    main: {
      type: "query",
      description: "Discover users from relays and backfill their records from PDS",
      parameters: {
        type: "params",
        properties: {
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 10,
          },
        },
      },
      output: {
        encoding: "application/json",
        schema: {
          type: "object",
          required: ["discovered", "backfilled", "remaining", "done"],
          properties: {
            discovered: { type: "integer" },
            backfilled: { type: "integer" },
            remaining: { type: "integer" },
            done: { type: "boolean" },
          },
        },
      },
    },
  },
});

writeLexicon(`${ns}.admin.reset`, {
  lexicon: 1,
  id: `${ns}.admin.reset`,
  defs: {
    main: {
      type: "query",
      description: "Delete all data from all tables",
      output: {
        encoding: "application/json",
        schema: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        },
      },
    },
  },
});

// --- getProfile endpoint ---

writeLexicon(`${ns}.getProfile`, {
  lexicon: 1,
  id: `${ns}.getProfile`,
  defs: {
    main: {
      type: "query",
      description: "Get a user's profile by DID or handle",
      parameters: {
        type: "params",
        required: ["actor"],
        properties: {
          actor: {
            type: "string",
            format: "at-identifier",
            description: "DID or handle of the user",
          },
        },
      },
      output: {
        encoding: "application/json",
        schema: {
          type: "ref",
          ref: "#profileEntry",
        },
      },
    },
    ...profileDefs(),
  },
});

// --- Per-collection endpoints ---

console.log("Generating collection endpoints...");

// Collect resolved queryable fields for all collections
const resolvedQueryable: Record<string, Record<string, { type?: "range" }>> = {};
// Collect resolved relation mappings (short name → full token) for runtime
const resolvedRelations: Record<string, Record<string, { collection: string; groupBy: string; groups: Record<string, string> }>> = {};

for (const [collection, colConfig] of Object.entries(config.collections)) {
  const collectionRef = getCollectionLexiconRef(collection);
  if (collectionRef) {
    console.log(`    → ${collection} record typed via lexicon`);
  }

  // Auto-detect queryable fields from lexicon, then merge manual overrides
  const autoDetected = detectQueryableFields(collection);
  const manual = colConfig.queryable ?? {};
  const merged = { ...autoDetected, ...manual };
  resolvedQueryable[collection] = merged;

  if (Object.keys(autoDetected).length > 0) {
    const autoOnly = Object.keys(autoDetected).filter((k) => !manual[k]);
    if (autoOnly.length > 0) {
      console.log(`    → auto-detected queryable: ${autoOnly.join(", ")}`);
    }
  }

  // --- listRecords ---
  const listRecordsParamProps: Record<string, any> = {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    cursor: { type: "string" },
    actor: { type: "string", format: "at-identifier", description: "Filter by DID or handle (triggers on-demand backfill)" },
    profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
  };

  for (const [field, fieldConfig] of Object.entries(merged)) {
    const param = fieldToParam(field);
    if (fieldConfig.type === "range") {
      listRecordsParamProps[`${param}Min`] = {
        type: "string",
        description: `Minimum value for ${field}`,
      };
      listRecordsParamProps[`${param}Max`] = {
        type: "string",
        description: `Maximum value for ${field}`,
      };
    } else {
      listRecordsParamProps[param] = {
        type: "string",
        description: `Filter by ${field}`,
      };
    }
  }

  // Build count fields, hydrate params, and relation defs from relations + knownValues
  const countFields: CountField[] = [];
  const relationDefs: RelationDef[] = [];
  for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    // Total count
    countFields.push({ name: `${relName}Count`, description: `Total ${relName} count` });
    listRecordsParamProps[`${relName}CountMin`] = {
      type: "integer",
      description: `Minimum total ${relName} count`,
    };

    // Per-relation hydrate param (e.g. hydrateRsvps=5)
    listRecordsParamProps[`hydrate${capitalize(relName)}`] = {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: `Number of ${relName} records to embed per record`,
    };

    // Per-group counts from knownValues
    const groupMapping: Record<string, string> = {};
    if (rel.groupBy) {
      const knownValues = getKnownValues(rel.collection, rel.groupBy);
      for (const token of knownValues) {
        const shortName = tokenShortName(token);
        groupMapping[shortName] = token;
        countFields.push({
          name: `${relName}${capitalize(shortName)}Count`,
          description: `${relName} count where ${rel.groupBy} = ${shortName}`,
        });
        listRecordsParamProps[`${relName}${capitalize(shortName)}CountMin`] = {
          type: "integer",
          description: `Minimum ${relName} count where ${rel.groupBy} = ${shortName}`,
        };
      }
      // Store mapping for runtime use
      if (!resolvedRelations[collection]) resolvedRelations[collection] = {};
      resolvedRelations[collection][relName] = {
        collection: rel.collection,
        groupBy: rel.groupBy,
        groups: groupMapping,
      };
    }

    relationDefs.push({
      relName,
      collection: rel.collection,
      groupBy: rel.groupBy,
      groups: groupMapping,
    });
  }

  // Build sortable field values: queryable fields + count fields
  const sortableValues: string[] = [];
  for (const field of Object.keys(merged)) {
    sortableValues.push(fieldToParam(field));
  }
  for (const cf of countFields) {
    sortableValues.push(cf.name);
  }

  if (sortableValues.length > 0) {
    listRecordsParamProps["sort"] = {
      type: "string",
      knownValues: sortableValues,
      description: "Field to sort by (default: time_us)",
    };
    listRecordsParamProps["order"] = {
      type: "string",
      knownValues: ["asc", "desc"],
      description: "Sort direction (default: desc for dates/numbers/counts, asc for strings)",
    };
  }

  const hydrateDefs = buildHydrateDefs(relationDefs);

  writeLexicon(`${collection}.listRecords`, {
    lexicon: 1,
    id: `${collection}.listRecords`,
    defs: {
      main: {
        type: "query",
        description: `Query ${collection} records with filters`,
        parameters: {
          type: "params",
          properties: listRecordsParamProps,
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["records"],
            properties: {
              records: { type: "array", items: { type: "ref", ref: "#record" } },
              cursor: { type: "string" },
              profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } },
            },
          },
        },
      },
      record: buildRecordDef(collectionRef, countFields, relationDefs),
      ...hydrateDefs,
      ...profileDefs(),
    },
  });

  // --- getRecord ---
  const getRecordParamProps: Record<string, any> = {
    uri: { type: "string", format: "at-uri", description: "AT URI of the record" },
    profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
  };

  // Add per-relation hydrate params to getRecord too
  for (const rd of relationDefs) {
    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    getRecordParamProps[`hydrate${capitalize(rd.relName)}`] = {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: `Number of ${rd.relName} records to embed`,
    };
  }

  writeLexicon(`${collection}.getRecord`, {
    lexicon: 1,
    id: `${collection}.getRecord`,
    defs: {
      main: {
        type: "query",
        description: `Get a single ${collection} record by AT URI`,
        parameters: {
          type: "params",
          required: ["uri"],
          properties: getRecordParamProps,
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["uri", "did", "collection", "rkey", "time_us"],
            properties: {
              ...buildRecordDef(collectionRef, countFields, relationDefs).properties,
              profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } },
            },
          },
        },
      },
      ...hydrateDefs,
      ...profileDefs(),
    },
  });


  // --- Custom queries ---
  for (const queryName of Object.keys(colConfig.queries ?? {})) {
    writeLexicon(`${collection}.${queryName}`, {
      lexicon: 1,
      id: `${collection}.${queryName}`,
      defs: {
        main: {
          type: "query",
          description: `Custom query: ${queryName}`,
          output: {
            encoding: "application/json",
            schema: { type: "object", properties: {} },
          },
        },
      },
    });
  }
}

// --- Auto-generate lex.config.js ---

// Collect all collection NSIDs from config
const collectionNsids = Object.keys(config.collections);

// Scan pulled lexicons for external refs to find transitive deps
function findRefsInLexicon(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const refs: string[] = [];
    // Match all "ref": "some.nsid.here" or "refs": ["some.nsid.here"]
    const refPattern = /"ref":\s*"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)(?:#\w+)?"/g;
    let match;
    while ((match = refPattern.exec(content)) !== null) {
      refs.push(match[1]);
    }
    // Also match refs arrays
    const refsArrayPattern = /"refs":\s*\[([^\]]+)\]/g;
    while ((match = refsArrayPattern.exec(content)) !== null) {
      const inner = match[1];
      const nsidPattern = /"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)(?:#\w+)?"/g;
      let innerMatch;
      while ((innerMatch = nsidPattern.exec(inner)) !== null) {
        refs.push(innerMatch[1]);
      }
    }
    return refs;
  } catch {
    return [];
  }
}

function scanLexiconsDir(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanLexiconsDir(fullPath));
    } else if (entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

// Find all NSIDs referenced by pulled lexicons
const pulledFiles = [
  ...scanLexiconsDir(USER_LEXICONS_DIR),
  ...scanLexiconsDir(PULLED_LEXICONS_DIR),
];
const allRefs = new Set<string>();
for (const file of pulledFiles) {
  for (const ref of findRefsInLexicon(file)) {
    allRefs.add(ref);
  }
}

// Merge: collection NSIDs + profile NSIDs + transitive deps (excluding com.atproto.* which comes from imports)
const profileNsids = config.profiles ?? ["app.bsky.actor.profile"];
const pullNsids = new Set([...collectionNsids, ...profileNsids]);
for (const ref of allRefs) {
  if (!ref.startsWith("com.atproto.")) {
    pullNsids.add(ref);
  }
}

const sortedNsids = [...pullNsids].sort();

const lexConfigContent = `import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  files: ["lexicons/**/*.json", "lexicons-pulled/**/*.json", "lexicons-generated/**/*.json"],
  outdir: "src/lexicon-types/",
  imports: ["@atcute/atproto"],
  pull: {
    outdir: "lexicons-pulled/",
    sources: [
      {
        type: "atproto",
        mode: "nsids",
        nsids: ${JSON.stringify(sortedNsids, null, 10).replace(/^/gm, "        ").trim()},
      },
    ],
  },
});
`;

writeFileSync(join(ROOT_DIR, "lex.config.js"), lexConfigContent);
console.log(`\nGenerated lex.config.js with ${sortedNsids.length} pull NSIDs`);

// Generate resolved queryable config for runtime use
const queryableContent = `// Auto-generated — do not edit. Run \`pnpm generate\` to regenerate.
import type { QueryableField } from "./types";

export const resolvedQueryable: Record<string, Record<string, QueryableField>> = ${JSON.stringify(resolvedQueryable, null, 2)};

export interface ResolvedRelation {
  collection: string;
  groupBy: string;
  groups: Record<string, string>; // shortName → full token value
}

export const resolvedRelationsMap: Record<string, Record<string, ResolvedRelation>> = ${JSON.stringify(resolvedRelations, null, 2)};
`;

writeFileSync(join(ROOT_DIR, "src", "core", "queryable.generated.ts"), queryableContent);
console.log("Generated src/core/queryable.generated.ts");

console.log("\nDone!");
