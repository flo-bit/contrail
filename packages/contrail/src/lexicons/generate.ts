import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CollectionConfig,
  ContrailConfig,
  RelationConfig,
} from "../core/types.js";
import {
  getCollectionMethods,
  normalizeFeedTarget,
  resolveConfig,
} from "../core/types.js";

export type LexiconSurface = "full" | "public";

export interface GenerateLexiconsOptions {
  config: ContrailConfig;
  rootDir: string;
  outputDir?: string;
  sourceDirs?: string[];
  surface?: LexiconSurface;
  writeAtcuteConfig?: boolean;
  quiet?: boolean;
}

export interface GenerateLexiconsResult {
  /** Method Lexicons authored by Contrail for this config. */
  generated: Record<string, object>;
  /** Complete service bundle: generated methods plus available source/ref docs. */
  lexicons: object[];
  methods: string[];
  pullNsids: string[];
}

interface RelationDef {
  name: string;
  collection: string;
  groupBy?: string;
  groups: Record<string, string>;
  count: boolean;
}

interface ReferenceDef {
  name: string;
  collection: string;
}

function* walkJson(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkJson(path);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield path;
  }
}

function fieldToParam(field: string): string {
  return field.replace(/\.(\w)/g, (_, character: string) =>
    character.toUpperCase(),
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function tokenShortName(token: string): string {
  const hash = token.indexOf("#");
  return hash === -1 ? token : token.slice(hash + 1);
}

function readLexicon(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function findLexicon(sourceDirs: string[], nsid: string): string | null {
  const suffix = `${nsid.split(".").join("/")}.json`;
  for (const directory of sourceDirs) {
    const path = join(directory, suffix);
    if (existsSync(path)) return path;
  }
  return null;
}

function collectionReference(
  sourceDirs: string[],
  nsid: string,
): string | null {
  const path = findLexicon(sourceDirs, nsid);
  const document = path ? readLexicon(path) : null;
  return document?.defs?.main ? `${nsid}#main` : null;
}

function groupsForRelation(
  sourceDirs: string[],
  config: ContrailConfig,
  relation: RelationConfig,
): Record<string, string> {
  if (relation.groups && Object.keys(relation.groups).length > 0) {
    return Object.fromEntries(Object.entries(relation.groups).sort());
  }
  if (!relation.groupBy) return {};
  const nsid =
    config.collections[relation.collection]?.collection ?? relation.collection;
  const path = findLexicon(sourceDirs, nsid);
  const document = path ? readLexicon(path) : null;
  const field = document?.defs?.main?.record?.properties?.[relation.groupBy];
  const values: unknown[] = Array.isArray(field?.knownValues)
    ? field.knownValues
    : [];
  return Object.fromEntries(
    values
      .filter((value: unknown): value is string => typeof value === "string")
      .map((value: string): [string, string] => [tokenShortName(value), value])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function profileDefinitions(config: ContrailConfig, sourceDirs: string[]) {
  const profiles = config.profiles ?? [];
  if (profiles.length === 0) return {};
  const refs: string[] = [];
  for (const profile of profiles) {
    const collection =
      typeof profile === "string" ? profile : profile.collection;
    if (collectionReference(sourceDirs, collection)) {
      refs.push(`${collection}#main`);
    }
  }
  const value =
    refs.length === 1
      ? { type: "ref", ref: refs[0] }
      : refs.length > 1
        ? { type: "union", refs }
        : { type: "unknown" };
  return {
    profileEntry: {
      type: "object",
      required: ["did"],
      properties: {
        did: { type: "string", format: "did" },
        handle: { type: "string" },
        uri: { type: "string", format: "at-uri" },
        cid: { type: "string", format: "cid" },
        value,
        collection: { type: "string", format: "nsid" },
        rkey: { type: "string" },
      },
    },
  };
}

function recordDefinition(
  sourceDirs: string[],
  collection: string,
  relations: RelationDef[],
  references: ReferenceDef[],
) {
  const properties: Record<string, any> = {
    uri: { type: "string", format: "at-uri" },
    cid: { type: "string", format: "cid" },
    value: collectionReference(sourceDirs, collection)
      ? { type: "ref", ref: `${collection}#main` }
      : { type: "unknown" },
    did: { type: "string", format: "did" },
    collection: { type: "string", format: "nsid" },
    rkey: { type: "string" },
    time_us: { type: "integer" },
  };
  for (const relation of relations) {
    if (relation.count) {
      properties[`${relation.name}Count`] = {
        type: "integer",
        description: `Total ${relation.name} count`,
      };
      for (const shortName of Object.keys(relation.groups)) {
        properties[`${relation.name}${capitalize(shortName)}Count`] = {
          type: "integer",
          description: `${relation.name} count where ${relation.groupBy} = ${shortName}`,
        };
      }
    }
    properties[relation.name] =
      relation.groupBy && Object.keys(relation.groups).length > 0
        ? { type: "ref", ref: `#hydrate${capitalize(relation.name)}` }
        : {
            type: "array",
            items: {
              type: "ref",
              ref: `#hydrate${capitalize(relation.name)}Record`,
            },
          };
  }
  for (const reference of references) {
    properties[reference.name] = {
      type: "ref",
      ref: `#ref${capitalize(reference.name)}Record`,
    };
  }
  return {
    type: "object",
    required: ["uri", "cid", "value", "did", "collection", "rkey", "time_us"],
    properties,
  };
}

function relatedRecordDefinition(sourceDirs: string[], collection: string) {
  const reference = collectionReference(sourceDirs, collection);
  return {
    type: "object",
    required: ["uri", "value", "did", "collection", "rkey", "time_us"],
    properties: {
      uri: { type: "string", format: "at-uri" },
      cid: { type: "string", format: "cid" },
      value: reference ? { type: "ref", ref: reference } : { type: "unknown" },
      did: { type: "string", format: "did" },
      collection: { type: "string", format: "nsid" },
      rkey: { type: "string" },
      time_us: { type: "integer" },
    },
  };
}

function hydrationDefinitions(
  sourceDirs: string[],
  relations: RelationDef[],
  references: ReferenceDef[],
): Record<string, any> {
  const definitions: Record<string, any> = {};
  for (const relation of relations) {
    const recordName = `hydrate${capitalize(relation.name)}Record`;
    definitions[recordName] = relatedRecordDefinition(
      sourceDirs,
      relation.collection,
    );
    if (relation.groupBy && Object.keys(relation.groups).length > 0) {
      definitions[`hydrate${capitalize(relation.name)}`] = {
        type: "object",
        properties: Object.fromEntries([
          ...Object.keys(relation.groups).map((name) => [
            name,
            { type: "array", items: { type: "ref", ref: `#${recordName}` } },
          ]),
          [
            "other",
            { type: "array", items: { type: "ref", ref: `#${recordName}` } },
          ],
        ]),
      };
    }
  }
  for (const reference of references) {
    definitions[`ref${capitalize(reference.name)}Record`] =
      relatedRecordDefinition(sourceDirs, reference.collection);
  }
  return definitions;
}

function relationDefinitions(
  sourceDirs: string[],
  config: ContrailConfig,
  collection: CollectionConfig,
): RelationDef[] {
  return Object.entries(collection.relations ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, relation]) => ({
      name,
      collection:
        config.collections[relation.collection]?.collection ??
        relation.collection,
      groupBy: relation.groupBy,
      groups: groupsForRelation(sourceDirs, config, relation),
      count: relation.count !== false,
    }));
}

function referenceDefinitions(
  config: ContrailConfig,
  collection: CollectionConfig,
): ReferenceDef[] {
  return Object.entries(collection.references ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, reference]) => ({
      name,
      collection:
        config.collections[reference.collection]?.collection ??
        reference.collection,
    }));
}

function listParameters(
  config: ContrailConfig,
  collection: CollectionConfig,
  relations: RelationDef[],
  references: ReferenceDef[],
  surface: LexiconSurface,
) {
  const properties: Record<string, any> = {
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    cursor: { type: "string" },
    actor: {
      type: "string",
      format: "at-identifier",
      description:
        surface === "public"
          ? "Filter by an indexed DID or cached handle"
          : "Filter by DID or handle",
    },
  };
  if ((config.profiles?.length ?? 0) > 0) {
    properties.profiles = {
      type: "boolean",
      description: "Include indexed profile and identity information",
    };
  }
  if (
    Array.isArray(collection.searchable) &&
    collection.searchable.length > 0
  ) {
    properties.search = {
      type: "string",
      description: `Full-text search across: ${collection.searchable.join(", ")}`,
    };
  }
  for (const [field, queryable] of Object.entries(
    collection.queryable ?? {},
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const parameter = fieldToParam(field);
    if (queryable.type === "range") {
      properties[`${parameter}Min`] = {
        type: "string",
        description: `Minimum value for ${field}`,
      };
      properties[`${parameter}Max`] = {
        type: "string",
        description: `Maximum value for ${field}`,
      };
    } else {
      properties[parameter] = {
        type: "string",
        description: `Filter by ${field}`,
      };
    }
  }
  const sortable = Object.keys(collection.queryable ?? {}).map(fieldToParam);
  for (const relation of relations) {
    if (relation.count) {
      properties[`${relation.name}CountMin`] = {
        type: "integer",
        description: `Minimum total ${relation.name} count`,
      };
      sortable.push(`${relation.name}Count`);
      for (const shortName of Object.keys(relation.groups)) {
        const base = `${relation.name}${capitalize(shortName)}Count`;
        properties[`${base}Min`] = {
          type: "integer",
          description: `Minimum ${relation.name} count where ${relation.groupBy} = ${shortName}`,
        };
        sortable.push(base);
      }
    }
    properties[`hydrate${capitalize(relation.name)}`] = {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: `Number of ${relation.name} records to embed`,
    };
  }
  for (const reference of references) {
    properties[`hydrate${capitalize(reference.name)}`] = {
      type: "boolean",
      description: `Embed the referenced ${reference.name} record`,
    };
  }
  if (sortable.length > 0) {
    properties.sort = {
      type: "string",
      knownValues: [...new Set(sortable)].sort(),
      description: "Field to sort by (default: time_us)",
    };
    properties.order = {
      type: "string",
      knownValues: ["asc", "desc"],
      description: "Sort direction",
    };
  }
  return properties;
}

function getParameters(
  config: ContrailConfig,
  relations: RelationDef[],
  references: ReferenceDef[],
) {
  const properties: Record<string, any> = {
    uri: {
      type: "string",
      format: "at-uri",
      description: "AT URI of the record",
    },
  };
  if ((config.profiles?.length ?? 0) > 0) {
    properties.profiles = {
      type: "boolean",
      description: "Include indexed profile and identity information",
    };
  }
  for (const relation of relations) {
    properties[`hydrate${capitalize(relation.name)}`] = {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: `Number of ${relation.name} records to embed`,
    };
  }
  for (const reference of references) {
    properties[`hydrate${capitalize(reference.name)}`] = {
      type: "boolean",
      description: `Embed the referenced ${reference.name} record`,
    };
  }
  return properties;
}

function collectReferencedNsids(path: string): string[] {
  const document = readLexicon(path);
  const values = new Set<string>();
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string" && (key === "ref" || key === "refs")) {
      const nsid = value.split("#", 1)[0];
      if (nsid?.includes(".")) values.add(nsid);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value)
        visit(child, key === "refs" ? "refs" : undefined);
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value))
        visit(child, childKey);
    }
  };
  visit(document);
  return [...values];
}

function calculatePullNsids(
  config: ContrailConfig,
  sourceDirs: string[],
): string[] {
  const values = new Set(
    Object.values(config.collections)
      .map((collection) => collection.collection)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const directory of sourceDirs) {
    for (const path of walkJson(directory)) {
      for (const nsid of collectReferencedNsids(path)) values.add(nsid);
    }
  }

  // Custom and registry-pinned documents are deliberately immutable inputs.
  // Keep mutable `pulled` documents in Atcute's refresh list, but do not fetch
  // another copy of a source the project owns or has pinned by CID.
  const fixedSourceDirs = sourceDirs.filter((directory) => {
    const name = directory.replaceAll("\\", "/").split("/").pop();
    return name === "custom" || name === "pinned";
  });
  return [...values]
    .filter((nsid) => !findLexicon(fixedSourceDirs, nsid))
    .sort();
}

const GENERATED_ATCUTE_CONFIG_HEADER =
  "// Generated by `contrail lexicons generate`. Re-run the command to update; do not edit.\n";

function atcuteConfiguration(pullNsids: string[]): string {
  return `${GENERATED_ATCUTE_CONFIG_HEADER}import { defineLexiconConfig } from "@atcute/lex-cli";\n\nexport default defineLexiconConfig({\n  generate: {\n    files: [\n      "lexicons/custom/**/*.json",\n      "lexicons/pinned/**/*.json",\n      "lexicons/pulled/**/*.json",\n      "lexicons/generated/**/*.json",\n    ],\n    outdir: "src/lexicon-types/",\n  },\n  pull: {\n    outdir: "lexicons/pulled/",\n    clean: true,\n    sources: [\n      {\n        type: "atproto",\n        mode: "nsids",\n        nsids: ${JSON.stringify(pullNsids, null, 2).replace(/^/gm, "        ").trim()},\n      },\n    ],\n  },\n});\n`;
}

function writeAtcuteConfiguration(rootDir: string, pullNsids: string[]): boolean {
  const path = join(rootDir, "lex.config.js");
  const source = atcuteConfiguration(pullNsids);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    const legacyGeneratedSource = source.slice(GENERATED_ATCUTE_CONFIG_HEADER.length);
    if (
      !current.startsWith(GENERATED_ATCUTE_CONFIG_HEADER) &&
      current !== legacyGeneratedSource
    ) {
      return false;
    }
  }
  writeFileSync(path, source);
  return true;
}

function bundleDocuments(
  generated: Record<string, object>,
  sourceDirs: string[],
): object[] {
  const documents = new Map<string, object>();
  for (const [id, document] of Object.entries(generated)) {
    documents.set(id, document);
  }
  for (const directory of sourceDirs) {
    for (const path of walkJson(directory)) {
      const document = readLexicon(path);
      const id = document?.id;
      if (typeof id === "string" && !documents.has(id)) {
        documents.set(id, document as object);
      }
    }
  }
  return [...documents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, document]) => document);
}

function writeBundle(
  outputDir: string,
  generated: Record<string, object>,
  sourceDirs: string[],
) {
  const paths = new Set<string>();
  for (const nsid of Object.keys(generated)) {
    paths.add(`./${nsid.split(".").join("/")}.json`);
  }
  for (const directory of sourceDirs) {
    for (const path of walkJson(directory)) {
      let rel = relative(outputDir, path);
      if (!rel.startsWith(".")) rel = `./${rel}`;
      paths.add(rel);
    }
  }
  const sorted = [...paths].sort();
  const imports = sorted
    .map((path, index) => `import _${index} from "${path}";`)
    .join("\n");
  const values = sorted.map((_, index) => `_${index}`).join(", ");
  writeFileSync(
    join(outputDir, "index.ts"),
    `// Auto-generated by @atmo-dev/contrail. Do not edit.\n` +
      `// Regenerate with \`contrail lexicons generate\`.\n\n` +
      `${imports}\n\nexport const lexicons: object[] = [${values}];\n`,
  );
}

function feedLexicon(
  config: ContrailConfig,
  sourceDirs: string[],
): object | null {
  if (!config.feeds || Object.keys(config.feeds).length === 0) return null;
  const targets = [
    ...new Set(
      Object.values(config.feeds).flatMap((feed) =>
        feed.targets.map((target) => normalizeFeedTarget(target).collection),
      ),
    ),
  ].sort();
  const targetNsids = targets
    .map((target) => config.collections[target]?.collection)
    .filter((value): value is string => typeof value === "string");
  const parameters: Record<string, any> = {
    feed: {
      type: "string",
      knownValues: Object.keys(config.feeds).sort(),
    },
    actor: {
      type: "string",
      format: "at-identifier",
      description: "DID or handle whose feed should be queried",
    },
    collection: {
      type: "string",
      knownValues: targetNsids,
    },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    cursor: { type: "string" },
  };
  if ((config.profiles?.length ?? 0) > 0) {
    parameters.profiles = { type: "boolean" };
  }
  const recordDefinitions: Record<string, any> = {};
  const recordRefs: string[] = [];
  const hydrateDefinitions: Record<string, any> = {};
  for (const target of targets) {
    const collection = config.collections[target];
    if (!collection) continue;
    const relations = relationDefinitions(sourceDirs, config, collection);
    const references = referenceDefinitions(config, collection);
    const targetParams = listParameters(
      config,
      collection,
      relations,
      references,
      "full",
    );
    for (const [name, value] of Object.entries(targetParams)) {
      if (["limit", "cursor", "actor", "profiles"].includes(name)) continue;
      if (name === "sort" && parameters.sort) {
        parameters.sort.knownValues = [
          ...new Set([
            ...(parameters.sort.knownValues ?? []),
            ...((value as any).knownValues ?? []),
          ]),
        ].sort();
      } else {
        parameters[name] ??= value;
      }
    }
    const definition = `feedRecord${capitalize(target.replace(/[^a-zA-Z0-9]/g, "_"))}`;
    recordDefinitions[definition] = recordDefinition(
      sourceDirs,
      collection.collection ?? target,
      relations,
      references,
    );
    recordRefs.push(`#${definition}`);
    Object.assign(
      hydrateDefinitions,
      hydrationDefinitions(sourceDirs, relations, references),
    );
  }
  if (recordRefs.length === 0) {
    throw new Error(
      "configured feeds require at least one valid target collection",
    );
  }
  const recordItems =
    recordRefs.length === 1
      ? { type: "ref", ref: recordRefs[0] }
      : { type: "union", refs: recordRefs };
  const outputProperties: Record<string, any> = {
    records: { type: "array", items: recordItems },
    cursor: { type: "string" },
  };
  if ((config.profiles?.length ?? 0) > 0) {
    outputProperties.profiles = {
      type: "array",
      items: { type: "ref", ref: "#profileEntry" },
    };
  }
  return {
    lexicon: 1,
    id: `${config.namespace}.getFeed`,
    defs: {
      main: {
        type: "query",
        description: "Get a configured personalized feed",
        parameters: {
          type: "params",
          required: ["feed", "actor"],
          properties: parameters,
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["records"],
            properties: outputProperties,
          },
        },
      },
      ...recordDefinitions,
      ...hydrateDefinitions,
      ...profileDefinitions(config, sourceDirs),
    },
  };
}

function customMethodIds(config: ContrailConfig): string[] {
  const values: string[] = [];
  for (const [alias, collection] of Object.entries(config.collections)) {
    for (const name of new Set([
      ...Object.keys(collection.queries ?? {}),
      ...Object.keys(collection.pipelineQueries ?? {}),
    ])) {
      values.push(`${config.namespace}.${alias}.${name}`);
    }
  }
  return values.sort();
}

export function extractXrpcMethods(
  documents: Record<string, object>,
): string[] {
  return Object.entries(documents)
    .filter(([, document]) => {
      const type = (document as any)?.defs?.main?.type;
      return type === "query" || type === "procedure";
    })
    .map(([nsid]) => nsid)
    .sort();
}

function cursorLexicon(config: ContrailConfig): object {
  const unscopedProperties = {
    cursor: { type: "integer" },
  };
  if (!config.orderedSource) {
    return {
      lexicon: 1,
      id: `${config.namespace}.getCursor`,
      defs: {
        main: {
          type: "query",
          description: "Get the current Jetstream live cursor",
          output: {
            encoding: "application/json",
            schema: { type: "object", properties: unscopedProperties },
          },
        },
      },
    };
  }
  return {
    lexicon: 1,
    id: `${config.namespace}.getCursor`,
    defs: {
      main: {
        type: "query",
        description: "Get the committed primary ordered-source position",
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              position: { type: "ref", ref: "#sourcePosition" },
              updatedAt: { type: "integer" },
              updatedAtDate: { type: "string", format: "datetime" },
            },
          },
        },
      },
      sourcePosition: {
        type: "object",
        required: ["source", "epoch", "cursor"],
        properties: {
          source: { type: "string" },
          epoch: { type: "string" },
          cursor: { type: "string" },
        },
      },
    },
  };
}

export function generateLexicons(
  options: GenerateLexiconsOptions,
): GenerateLexiconsResult {
  const config = resolveConfig(options.config);
  const surface = options.surface ?? "full";
  const rootDir = resolve(options.rootDir);
  const outputDir = options.outputDir
    ? resolve(rootDir, options.outputDir)
    : join(rootDir, "lexicons", "generated");
  const outputRelative = relative(rootDir, outputDir);
  if (
    outputRelative === "" ||
    outputRelative === ".." ||
    outputRelative.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(outputRelative)
  ) {
    throw new Error(
      "generated Lexicon output must stay inside the project root",
    );
  }
  const sourceDirs = options.sourceDirs ?? [
    join(rootDir, "lexicons", "custom"),
    join(rootDir, "lexicons", "pinned"),
    join(rootDir, "lexicons", "pulled"),
  ];
  const log = options.quiet ? () => {} : console.log;
  const generated: Record<string, object> = {};

  for (const method of customMethodIds(config)) {
    if (!findLexicon(sourceDirs, method)) {
      throw new Error(
        `custom query ${method} requires a matching Lexicon under lexicons/custom`,
      );
    }
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const emit = (nsid: string, document: object) => {
    const path = join(outputDir, ...nsid.split(".")) + ".json";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    generated[nsid] = document;
    log(`  ${nsid}`);
  };

  emit(`${config.namespace}.getCursor`, cursorLexicon(config));
  if ((config.profiles?.length ?? 0) > 0) {
    emit(`${config.namespace}.getProfile`, {
      lexicon: 1,
      id: `${config.namespace}.getProfile`,
      defs: {
        main: {
          type: "query",
          parameters: {
            type: "params",
            required: ["actor"],
            properties: {
              actor: { type: "string", format: "at-identifier" },
            },
          },
          output: {
            encoding: "application/json",
            schema: {
              type: "object",
              required: ["profiles"],
              properties: {
                profiles: {
                  type: "array",
                  items: { type: "ref", ref: "#profileEntry" },
                },
              },
            },
          },
        },
        ...profileDefinitions(config, sourceDirs),
      },
    });
  }
  const feed = feedLexicon(config, sourceDirs);
  if (feed) emit(`${config.namespace}.getFeed`, feed);
  if (
    config.notify &&
    (surface === "full" ||
      config.notify === true ||
      config.serviceAuth?.methods.includes("notifyOfUpdate") === true)
  ) {
    emit(`${config.namespace}.notifyOfUpdate`, {
      lexicon: 1,
      id: `${config.namespace}.notifyOfUpdate`,
      defs: {
        main: {
          type: "procedure",
          description:
            "Fetch changed records from their authoritative PDS for immediate indexing",
          input: {
            encoding: "application/json",
            schema: {
              type: "object",
              properties: {
                uri: { type: "string", format: "at-uri" },
                uris: {
                  type: "array",
                  items: { type: "string", format: "at-uri" },
                  maxLength: 25,
                },
              },
            },
          },
          output: {
            encoding: "application/json",
            schema: {
              type: "object",
              required: ["indexed", "deleted"],
              properties: {
                indexed: { type: "integer", minimum: 0 },
                deleted: { type: "integer", minimum: 0 },
                errors: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
        },
      },
    });
  }

  for (const [alias, collectionConfig] of Object.entries(
    config.collections,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const collection = collectionConfig.collection ?? alias;
    const relations = relationDefinitions(sourceDirs, config, collectionConfig);
    const references = referenceDefinitions(config, collectionConfig);
    const hydrations = hydrationDefinitions(sourceDirs, relations, references);
    const profiles = profileDefinitions(config, sourceDirs);
    const methods = getCollectionMethods(collectionConfig);
    if (methods.includes("listRecords")) {
      const properties: Record<string, any> = {
        records: {
          type: "array",
          items: { type: "ref", ref: "#record" },
        },
        cursor: { type: "string" },
      };
      if ((config.profiles?.length ?? 0) > 0) {
        properties.profiles = {
          type: "array",
          items: { type: "ref", ref: "#profileEntry" },
        };
      }
      emit(`${config.namespace}.${alias}.listRecords`, {
        lexicon: 1,
        id: `${config.namespace}.${alias}.listRecords`,
        defs: {
          main: {
            type: "query",
            description: `Query ${collection} records`,
            parameters: {
              type: "params",
              properties: listParameters(
                config,
                collectionConfig,
                relations,
                references,
                surface,
              ),
            },
            output: {
              encoding: "application/json",
              schema: {
                type: "object",
                required: ["records"],
                properties,
              },
            },
          },
          record: recordDefinition(
            sourceDirs,
            collection,
            relations,
            references,
          ),
          ...hydrations,
          ...profiles,
        },
      });
    }
    if (methods.includes("getRecord")) {
      const properties = {
        ...recordDefinition(sourceDirs, collection, relations, references)
          .properties,
        ...((config.profiles?.length ?? 0) > 0
          ? {
              profiles: {
                type: "array",
                items: { type: "ref", ref: "#profileEntry" },
              },
            }
          : {}),
      };
      emit(`${config.namespace}.${alias}.getRecord`, {
        lexicon: 1,
        id: `${config.namespace}.${alias}.getRecord`,
        defs: {
          main: {
            type: "query",
            description: `Get a ${collection} record by AT URI`,
            parameters: {
              type: "params",
              required: ["uri"],
              properties: getParameters(config, relations, references),
            },
            output: {
              encoding: "application/json",
              schema: {
                type: "object",
                required: [
                  "uri",
                  "value",
                  "did",
                  "collection",
                  "rkey",
                  "time_us",
                ],
                properties,
              },
            },
          },
          ...hydrations,
          ...profiles,
        },
      });
    }
  }

  const pullNsids = calculatePullNsids(config, sourceDirs);
  if (
    options.writeAtcuteConfig !== false &&
    !writeAtcuteConfiguration(rootDir, pullNsids)
  ) {
    log("Preserved user-owned lex.config.js; update its pull sources manually.");
  }
  writeBundle(outputDir, generated, sourceDirs);
  const lexicons = bundleDocuments(generated, sourceDirs);
  const methods = [
    ...extractXrpcMethods(generated),
    ...customMethodIds(config),
  ].sort();
  log(`Generated ${Object.keys(generated).length} Contrail Lexicons.`);
  return { generated, lexicons, methods, pullNsids };
}

function directoryContents(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of walkJson(directory)) {
    files.set(relative(directory, path), readFileSync(path, "utf8"));
  }
  const index = join(directory, "index.ts");
  if (existsSync(index)) files.set("index.ts", readFileSync(index, "utf8"));
  return files;
}

export function checkLexicons(options: GenerateLexiconsOptions): void {
  const rootDir = resolve(options.rootDir);
  const outputDir = options.outputDir
    ? resolve(rootDir, options.outputDir)
    : join(rootDir, "lexicons", "generated");
  mkdirSync(dirname(outputDir), { recursive: true });
  const temporary = mkdtempSync(
    join(dirname(outputDir), ".contrail-lexicons-"),
  );
  try {
    const result = generateLexicons({
      ...options,
      outputDir: temporary,
      writeAtcuteConfig: false,
      quiet: true,
    });
    const expected = directoryContents(temporary);
    const actual = directoryContents(outputDir);
    const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
    const changed = paths.filter(
      (path) => expected.get(path) !== actual.get(path),
    );
    if (options.writeAtcuteConfig !== false) {
      const configPath = join(rootDir, "lex.config.js");
      const expectedConfig = atcuteConfiguration(result.pullNsids);
      const actualConfig = existsSync(configPath)
        ? readFileSync(configPath, "utf8")
        : undefined;
      const legacyGeneratedConfig = expectedConfig.slice(
        GENERATED_ATCUTE_CONFIG_HEADER.length,
      );
      if (
        actualConfig === undefined ||
        ((actualConfig.startsWith(GENERATED_ATCUTE_CONFIG_HEADER) ||
          actualConfig === legacyGeneratedConfig) &&
          actualConfig !== expectedConfig)
      ) {
        changed.push("lex.config.js");
      }
    }
    if (changed.length > 0) {
      throw new Error(
        `generated Contrail Lexicons are stale:\n${changed.map((path) => `  ${path}`).join("\n")}\nRun \`contrail lexicons generate\`.`,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
