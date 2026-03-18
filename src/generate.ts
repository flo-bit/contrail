/**
 * Core lexicon generation logic, importable for testing.
 *
 * Builds lexicon JSON objects from a ContrailConfig. Separated from the
 * script entry point so tests can call it with custom configs and output dirs.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { ContrailConfig } from "./core/types";

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
    join(rootDir, "lexicons"),
    join(rootDir, "lexicons-pulled"),
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
    const properties: Record<string, any> = {
      uri: { type: "string", format: "at-uri" },
      did: { type: "string", format: "did" },
      collection: { type: "string", format: "nsid" },
      rkey: { type: "string" },
      cid: { type: "string" },
      record: collectionRef ? { type: "ref", ref: collectionRef } : { type: "unknown" },
      time_us: { type: "integer" },
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
    return { type: "object", required: ["uri", "did", "collection", "rkey", "time_us"], properties };
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
        },
      };
    }
    return defs;
  }

  function profileDefs() {
    const profiles = config.profiles ?? ["app.bsky.actor.profile"];
    const extraDefs: Record<string, any> = {};
    const objectRefs: string[] = [];
    for (const col of profiles) {
      const schema = getRecordObjectSchema(col);
      if (!schema) continue;
      const defName = col.split(".").map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join("");
      extraDefs[defName] = schema;
      objectRefs.push(`#${defName}`);
    }
    let recordField: any;
    if (objectRefs.length === 1) recordField = { type: "ref", ref: objectRefs[0] };
    else if (objectRefs.length > 1) recordField = { type: "union", refs: objectRefs };
    else recordField = { type: "unknown" };
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

  function tokenShortName(token: string): string {
    const hash = token.indexOf("#");
    return hash !== -1 ? token.slice(hash + 1) : token;
  }

  // --- Generate ---

  const ns = config.namespace;

  log("Generating admin endpoints...");

  writeLexicon(`${ns}.admin.getCursor`, {
    lexicon: 1, id: `${ns}.admin.getCursor`,
    defs: { main: { type: "query", description: "Get the current cursor position", output: { encoding: "application/json", schema: { type: "object", properties: { time_us: { type: "integer" }, date: { type: "string" }, seconds_ago: { type: "integer" } } } } } },
  });

  writeLexicon(`${ns}.admin.getOverview`, {
    lexicon: 1, id: `${ns}.admin.getOverview`,
    defs: { main: { type: "query", description: "Get an overview of all indexed collections", output: { encoding: "application/json", schema: { type: "object", required: ["total_records", "collections"], properties: { total_records: { type: "integer" }, collections: { type: "array", items: { type: "ref", ref: "#collectionStats" } } } } } }, collectionStats: { type: "object", required: ["collection", "records", "unique_users"], properties: { collection: { type: "string" }, records: { type: "integer" }, unique_users: { type: "integer" } } } },
  });

  writeLexicon(`${ns}.admin.sync`, {
    lexicon: 1, id: `${ns}.admin.sync`,
    defs: { main: { type: "query", description: "Discover users from relays and backfill their records from PDS", parameters: { type: "params", properties: { concurrency: { type: "integer", minimum: 1, maximum: 50, default: 10 } } }, output: { encoding: "application/json", schema: { type: "object", required: ["discovered", "backfilled", "remaining", "done"], properties: { discovered: { type: "integer" }, backfilled: { type: "integer" }, remaining: { type: "integer" }, done: { type: "boolean" } } } } } },
  });

  writeLexicon(`${ns}.admin.reset`, {
    lexicon: 1, id: `${ns}.admin.reset`,
    defs: { main: { type: "query", description: "Delete all data from all tables", output: { encoding: "application/json", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } } },
  });

  writeLexicon(`${ns}.getProfile`, {
    lexicon: 1, id: `${ns}.getProfile`,
    defs: { main: { type: "query", description: "Get a user's profile by DID or handle", parameters: { type: "params", required: ["actor"], properties: { actor: { type: "string", format: "at-identifier", description: "DID or handle of the user" } } }, output: { encoding: "application/json", schema: { type: "ref", ref: "#profileEntry" } } }, ...profileDefs() },
  });

  writeLexicon(`${ns}.notifyOfUpdate`, {
    lexicon: 1, id: `${ns}.notifyOfUpdate`,
    defs: { main: { type: "procedure", description: "Notify of a record change for immediate indexing. Fetches the record from the user's PDS and indexes (or deletes) it.", input: { encoding: "application/json", schema: { type: "object", properties: { uri: { type: "string", format: "at-uri", description: "Single AT URI to fetch and index" }, uris: { type: "array", items: { type: "string", format: "at-uri" }, maxLength: 25, description: "Batch of AT URIs to fetch and index (max 25)" } } } }, output: { encoding: "application/json", schema: { type: "object", required: ["indexed", "deleted"], properties: { indexed: { type: "integer", description: "Number of records created or updated" }, deleted: { type: "integer", description: "Number of records deleted (not found on PDS)" }, errors: { type: "array", items: { type: "string" }, description: "Errors for individual URIs that could not be processed" } } } } } },
  });

  // --- Per-collection ---

  log("Generating collection endpoints...");

  const resolvedQueryableMap: Record<string, Record<string, { type?: "range" }>> = {};
  const resolvedRelationsMap: Record<string, Record<string, { collection: string; groupBy: string; groups: Record<string, string> }>> = {};

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const collectionRef = getCollectionLexiconRef(collection);

    const autoDetected = detectQueryableFields(collection);
    const manual = colConfig.queryable ?? {};
    const merged = { ...autoDetected, ...manual };
    resolvedQueryableMap[collection] = merged;

    // --- listRecords ---
    const listParams: Record<string, any> = {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      cursor: { type: "string" },
      actor: { type: "string", format: "at-identifier", description: "Filter by DID or handle (triggers on-demand backfill)" },
      profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
    };

    // Search param
    if (colConfig.searchable !== false) {
      const allQueryable = { ...autoDetected, ...manual };
      const searchableFields = Array.isArray(colConfig.searchable)
        ? colConfig.searchable
        : Object.entries(allQueryable).filter(([, f]) => f.type !== "range").map(([name]) => name);
      if (searchableFields.length > 0) {
        listParams["search"] = {
          type: "string",
          description: `Full-text search across: ${searchableFields.join(", ")}`,
        };
      }
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

      const groupMapping: Record<string, string> = {};
      if (rel.groupBy) {
        const knownValues = getKnownValues(rel.collection, rel.groupBy);
        for (const token of knownValues) {
          const shortName = tokenShortName(token);
          groupMapping[shortName] = token;
          countFields.push({ name: `${relName}${cap(shortName)}Count`, description: `${relName} count where ${rel.groupBy} = ${shortName}` });
          listParams[`${relName}${cap(shortName)}CountMin`] = { type: "integer", description: `Minimum ${relName} count where ${rel.groupBy} = ${shortName}` };
        }
        if (!resolvedRelationsMap[collection]) resolvedRelationsMap[collection] = {};
        resolvedRelationsMap[collection][relName] = { collection: rel.collection, groupBy: rel.groupBy, groups: groupMapping };
      }

      relationDefs.push({ relName, collection: rel.collection, groupBy: rel.groupBy, groups: groupMapping });
    }

    const referenceDefs: ReferenceDef[] = [];
    for (const [refName, ref] of Object.entries(colConfig.references ?? {})) {
      referenceDefs.push({ refName, collection: ref.collection });
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

    writeLexicon(`${collection}.listRecords`, {
      lexicon: 1, id: `${collection}.listRecords`,
      defs: {
        main: { type: "query", description: `Query ${collection} records with filters`, parameters: { type: "params", properties: listParams }, output: { encoding: "application/json", schema: { type: "object", required: ["records"], properties: { records: { type: "array", items: { type: "ref", ref: "#record" } }, cursor: { type: "string" }, profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } } } } } },
        record: buildRecordDef(collectionRef, countFields, relationDefs, referenceDefs),
        ...hydrateDefs, ...refDefs, ...profileDefs(),
      },
    });

    // --- getRecord ---
    const getParams: Record<string, any> = {
      uri: { type: "string", format: "at-uri", description: "AT URI of the record" },
      profiles: { type: "boolean", description: "Include profile + identity info keyed by DID" },
    };
    for (const rd of relationDefs) {
      getParams[`hydrate${cap(rd.relName)}`] = { type: "integer", minimum: 1, maximum: 50, description: `Number of ${rd.relName} records to embed` };
    }
    for (const refName of Object.keys(colConfig.references ?? {})) {
      getParams[`hydrate${cap(refName)}`] = { type: "boolean", description: `Embed the referenced ${refName} record` };
    }

    writeLexicon(`${collection}.getRecord`, {
      lexicon: 1, id: `${collection}.getRecord`,
      defs: {
        main: { type: "query", description: `Get a single ${collection} record by AT URI`, parameters: { type: "params", required: ["uri"], properties: getParams }, output: { encoding: "application/json", schema: { type: "object", required: ["uri", "did", "collection", "rkey", "time_us"], properties: { ...buildRecordDef(collectionRef, countFields, relationDefs, referenceDefs).properties, profiles: { type: "array", items: { type: "ref", ref: "#profileEntry" } } } } } },
        ...hydrateDefs, ...refDefs, ...profileDefs(),
      },
    });

    for (const queryName of Object.keys(colConfig.queries ?? {})) {
      writeLexicon(`${collection}.${queryName}`, {
        lexicon: 1, id: `${collection}.${queryName}`,
        defs: { main: { type: "query", description: `Custom query: ${queryName}`, output: { encoding: "application/json", schema: { type: "object", properties: {} } } } },
      });
    }
  }

  // --- Runtime files (only when called from script) ---
  if (options.writeRuntimeFiles) {
    // lex.config.js
    const collectionNsids = Object.keys(config.collections);
    const pulledFiles = [...scanLexiconsDir(lexiconDirs), ...scanLexiconsDir([])].flat();
    const allRefs = new Set<string>();
    for (const file of pulledFiles) {
      for (const ref of findRefsInLexicon(file)) allRefs.add(ref);
    }
    const profileNsids = config.profiles ?? ["app.bsky.actor.profile"];
    const pullNsids = new Set([...collectionNsids, ...profileNsids]);
    for (const ref of allRefs) {
      if (!ref.startsWith("com.atproto.")) pullNsids.add(ref);
    }
    const sortedNsids = [...pullNsids].sort();
    const lexConfigContent = `import { defineLexiconConfig } from "@atcute/lex-cli";\n\nexport default defineLexiconConfig({\n  files: ["lexicons/**/*.json", "lexicons-pulled/**/*.json", "lexicons-generated/**/*.json"],\n  outdir: "src/lexicon-types/",\n  imports: ["@atcute/atproto"],\n  pull: {\n    outdir: "lexicons-pulled/",\n    sources: [\n      {\n        type: "atproto",\n        mode: "nsids",\n        nsids: ${JSON.stringify(sortedNsids, null, 10).replace(/^/gm, "        ").trim()},\n      },\n    ],\n  },\n});\n`;
    writeFileSync(join(rootDir, "lex.config.js"), lexConfigContent);
    log(`\nGenerated lex.config.js with ${sortedNsids.length} pull NSIDs`);

    // queryable.generated.ts
    const queryableContent = `// Auto-generated — do not edit. Run \`pnpm generate\` to regenerate.\nimport type { QueryableField } from "./types";\n\nexport const resolvedQueryable: Record<string, Record<string, QueryableField>> = ${JSON.stringify(resolvedQueryableMap, null, 2)};\n\nexport interface ResolvedRelation {\n  collection: string;\n  groupBy: string;\n  groups: Record<string, string>; // shortName → full token value\n}\n\nexport const resolvedRelationsMap: Record<string, Record<string, ResolvedRelation>> = ${JSON.stringify(resolvedRelationsMap, null, 2)};\n`;
    writeFileSync(join(rootDir, "src", "core", "queryable.generated.ts"), queryableContent);
    log("Generated src/core/queryable.generated.ts");
  }

  log("\nDone!");
  return generated;
}

// --- Helpers used by writeRuntimeFiles ---

function analyzeProperties(
  defs: Record<string, any>,
  properties: Record<string, any>,
  prefix: string
): Record<string, QueryableField> {
  const result: Record<string, QueryableField> = {};
  for (const [field, def] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${field}` : field;
    if (def.type === "string") {
      if (def.format === "datetime") result[path] = { type: "range" };
      else if (def.format !== "uri" && def.format !== "at-uri") result[path] = {};
    } else if (def.type === "integer" || def.type === "number") {
      result[path] = { type: "range" };
    } else if (def.type === "ref" && def.ref === "com.atproto.repo.strongRef") {
      result[`${path}.uri`] = {};
    } else if (def.type === "union" && Array.isArray(def.refs) && def.refs.includes("com.atproto.repo.strongRef")) {
      result[`${path}.uri`] = {};
    } else if (def.type === "ref" && def.ref) {
      const refId = def.ref.includes("#") ? def.ref.split("#")[1] : null;
      if (refId && defs[refId]?.type === "string") result[path] = {};
    }
  }
  return result;
}

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
