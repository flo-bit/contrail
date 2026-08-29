import { isNsid } from "@atcute/lexicons/syntax";
import type {
  CollectionConfig,
  ContrailConfig,
  QueryableField,
} from "../../core/types.js";
import { validateConfig } from "../../core/types.js";
import type { PrefixAnalysis } from "./analyze.js";
import type { ReferenceChoice } from "./references.js";

export interface LexiconImportLock {
  format: "contrail.lexicon-import";
  version: 1;
  api: string;
  prefix: string;
  snapshot: string;
  partial: boolean;
  verification: PrefixAnalysis["graph"]["prefix"]["verification"];
  indexing: PrefixAnalysis["graph"]["prefix"]["indexing"];
  roots: string[];
  documents: Array<{
    id: string;
    cid: string;
    authorityDid: string;
    uri: string;
    role: "root" | "dependency";
    verifiedAt: string;
    verifiedUntil: string;
  }>;
}

export interface InitArtifacts {
  config: ContrailConfig;
  configSource: string;
  lock: LexiconImportLock;
  analysis: PrefixAnalysis;
  choices: ReferenceChoice[];
}

function groupName(value: string, used: Set<string>): string {
  const fragment = value.includes("#") ? value.slice(value.lastIndexOf("#") + 1) : value;
  const words = fragment.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  let base = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
  if (!base) base = "value";
  if (!/^[a-zA-Z]/.test(base)) base = `value${base}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}${suffix++}`;
  used.add(name);
  return name;
}

function formatKey(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
    ? key
    : JSON.stringify(key);
}

function renderValue(value: unknown, indentation = 0): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = " ".repeat(indentation);
    const child = " ".repeat(indentation + 2);
    return `[\n${value
      .map((item) => `${child}${renderValue(item, indentation + 2)},`)
      .join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  if (entries.length === 0) return "{}";
  const indent = " ".repeat(indentation);
  const child = " ".repeat(indentation + 2);
  return `{\n${entries
    .map(
      ([key, item]) =>
        `${child}${formatKey(key)}: ${renderValue(item, indentation + 2)},`,
    )
    .join("\n")}\n${indent}}`;
}

function cloneQueryable(
  queryable: Record<string, QueryableField>,
): Record<string, QueryableField> {
  return Object.fromEntries(
    Object.entries(queryable).map(([field, config]) => [field, { ...config }]),
  );
}

export function createInitArtifacts(
  namespace: string,
  analysis: PrefixAnalysis,
  choices: ReferenceChoice[] = [],
): InitArtifacts {
  const byAlias = new Map(
    analysis.collections.map((collection) => [collection.alias, collection]),
  );
  const collections: Record<string, CollectionConfig> = {};
  for (const collection of analysis.collections) {
    collections[collection.alias] = {
      collection: collection.nsid,
      validate: true,
      queryable: cloneQueryable(collection.queryable),
    };
  }

  for (const choice of choices) {
    const sourceAnalysis = byAlias.get(choice.source);
    const targetAnalysis = byAlias.get(choice.target);
    const source = collections[choice.source];
    const target = collections[choice.target];
    if (!sourceAnalysis || !targetAnalysis || !source || !target) {
      throw new Error(`Reference choice names an unknown collection`);
    }
    const candidate = sourceAnalysis.references.find(
      (reference) => reference.path === choice.path,
    );
    if (!candidate) {
      throw new Error(
        `Reference choice names unknown path ${choice.source}.${choice.path}`,
      );
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(choice.name)) {
      throw new Error(`Invalid reference name ${choice.source}.${choice.name}`);
    }
    source.references ??= {};
    if (source.references[choice.name]) {
      throw new Error(
        `Duplicate reference name ${choice.source}.${choice.name}`,
      );
    }
    source.references[choice.name] = {
      collection: choice.target,
      field: choice.path,
    };

    if (choice.inverse) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(choice.inverse.name)) {
        throw new Error(
          `Invalid relation name ${choice.target}.${choice.inverse.name}`,
        );
      }
      target.relations ??= {};
      if (target.relations[choice.inverse.name]) {
        throw new Error(
          `Duplicate relation name ${choice.target}.${choice.inverse.name}`,
        );
      }
      const group = choice.inverse.groupBy
        ? sourceAnalysis.groupFields.find(
            (field) => field.path === choice.inverse!.groupBy,
          )
        : undefined;
      if (choice.inverse.groupBy && !group) {
        throw new Error(
          `Unknown relation group field ${choice.source}.${choice.inverse.groupBy}`,
        );
      }
      const used = new Set<string>();
      target.relations[choice.inverse.name] = {
        collection: choice.source,
        field: choice.path,
        ...(group
          ? {
              groupBy: group.path,
              groups: Object.fromEntries(
                group.values.map((value) => [groupName(value, used), value]),
              ),
            }
          : {}),
      };
    }
  }

  const config: ContrailConfig = {
    namespace,
    profiles: [],
    collections,
  };
  validateConfig(config);
  for (const alias of Object.keys(collections)) {
    // A namespace is an XRPC prefix, not itself a complete NSID.
    const method = `${namespace}.${alias}.listRecords`;
    if (!isNsid(method)) {
      throw new Error(`Invalid generated XRPC namespace: ${namespace}`);
    }
  }

  const prefix = analysis.graph.prefix;
  const lock: LexiconImportLock = {
    format: "contrail.lexicon-import",
    version: 1,
    api: prefix.api,
    prefix: prefix.prefix,
    snapshot: prefix.snapshot,
    partial: prefix.partial,
    verification: prefix.verification,
    indexing: prefix.indexing,
    roots: [...analysis.graph.roots],
    documents: analysis.graph.documents.map((document) => ({
      id: document.id,
      cid: document.cid,
      authorityDid: document.authorityDid,
      uri: document.uri,
      role: document.role,
      verifiedAt: document.verifiedAt,
      verifiedUntil: document.verifiedUntil,
    })),
  };

  return {
    config,
    configSource: `export default ${renderValue(config)};\n`,
    lock,
    analysis,
    choices,
  };
}
