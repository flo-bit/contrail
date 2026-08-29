import { createHash } from "node:crypto";
import {
  findExternalReferences,
  lexiconDoc,
  parseLexiconRef,
  refineLexiconDoc,
  type LexiconDoc,
} from "@atcute/lexicon-doc";
import { parse as parseValibot } from "valibot";
import { validateFieldName, type QueryableField } from "../../core/types.js";
import type {
  PrefixImport,
  VerifiedLexiconDocument,
} from "./registry.js";

const STRONG_REF = "com.atproto.repo.strongRef";

export interface PinnedLexicon extends VerifiedLexiconDocument {
  role: "root" | "dependency";
}

export interface LexiconGraph {
  prefix: PrefixImport;
  roots: string[];
  documents: PinnedLexicon[];
  parsed: Map<string, LexiconDoc>;
}

export interface SkippedField {
  path: string;
  reason:
    | "array"
    | "blob"
    | "boolean"
    | "bytes"
    | "cid-link"
    | "constant"
    | "cycle"
    | "integer"
    | "object"
    | "token"
    | "union"
    | "unknown"
    | "unsafe-path"
    | "unsupported";
}

export interface ReferenceCandidate {
  path: string;
  kind: "at-uri" | "strongRef";
  cidPath?: string;
}

export interface GroupFieldCandidate {
  path: string;
  values: string[];
}

export interface CollectionAnalysis {
  nsid: string;
  alias: string;
  queryable: Record<string, QueryableField>;
  skipped: SkippedField[];
  references: ReferenceCandidate[];
  groupFields: GroupFieldCandidate[];
}

export interface PrefixAnalysis {
  graph: LexiconGraph;
  collections: CollectionAnalysis[];
}

function parseDocument(document: VerifiedLexiconDocument): LexiconDoc {
  let parsed: LexiconDoc;
  try {
    parsed = parseValibot(lexiconDoc, document.value);
  } catch {
    throw new Error(`verified Lexicon ${document.id} is not a valid document`);
  }
  const issues = refineLexiconDoc(parsed, true);
  if (issues.length > 0) {
    const issue = issues[0]!;
    throw new Error(
      `verified Lexicon ${document.id} is invalid at ${issue.path.join(".") || "document"}: ${issue.message}`,
    );
  }
  if (parsed.id !== document.id) {
    throw new Error(`verified Lexicon ID mismatch for ${document.id}`);
  }
  return parsed;
}

function primaryType(document: VerifiedLexiconDocument): unknown {
  return (document.value.defs as Record<string, any> | undefined)?.main?.type;
}

/** Select record roots and close their complete external Lexicon dependency graph. */
export async function buildLexiconGraph(
  prefix: PrefixImport,
  resolveExact: (nsid: string) => Promise<VerifiedLexiconDocument>,
): Promise<LexiconGraph> {
  const prefixDocuments = new Map(
    prefix.documents.map((document) => [document.id, document]),
  );
  const roots = prefix.documents
    .filter((document) => primaryType(document) === "record")
    .map((document) => document.id)
    .sort();
  if (roots.length === 0) {
    const detail =
      prefix.verification.candidates === 0
        ? "the prefix has no observed candidates"
        : `the prefix returned ${prefix.documents.length} verified documents but no records`;
    throw new Error(`No record Lexicons found for ${prefix.prefix}: ${detail}`);
  }

  const documents = new Map<string, VerifiedLexiconDocument>();
  const parsed = new Map<string, LexiconDoc>();
  const pending = [...roots];
  while (pending.length > 0) {
    const nsid = pending.shift()!;
    if (documents.has(nsid)) continue;
    const document = prefixDocuments.get(nsid) ?? (await resolveExact(nsid));
    const value = parseDocument(document);
    documents.set(nsid, document);
    parsed.set(nsid, value);

    for (const reference of findExternalReferences(value)) {
      const target = parseLexiconRef(reference, value.id).nsid;
      if (!documents.has(target) && !pending.includes(target)) {
        pending.push(target);
      }
    }
    pending.sort();
  }

  // Verify both external and local targets after the closure is present.
  for (const [nsid, document] of parsed) {
    for (const reference of findExternalReferences(document)) {
      const target = parseLexiconRef(reference, document.id);
      const dependency = parsed.get(target.nsid);
      if (!dependency) {
        throw new Error(`missing dependency ${target.nsid} referenced by ${nsid}`);
      }
      if (!dependency.defs[target.defId]) {
        throw new Error(
          `missing definition ${target.nsid}#${target.defId} referenced by ${nsid}`,
        );
      }
    }
  }

  const rootSet = new Set(roots);
  return {
    prefix,
    roots,
    parsed,
    documents: [...documents.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((document) => ({
        ...document,
        role: rootSet.has(document.id) ? "root" : "dependency",
      })),
  };
}

function normalizeSegment(segment: string): string {
  const words = segment.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return "collection";
  const value = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
  return /^[a-zA-Z]/.test(value) ? value : `collection${value}`;
}

function aliasAtDepth(nsid: string, depth: number): string {
  const parts = nsid.split(".");
  const selected = parts.slice(Math.max(0, parts.length - depth));
  return selected
    .map((part, index) => {
      const normalized = normalizeSegment(part);
      return index === 0
        ? normalized
        : normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join("");
}

/** Derive readable aliases while expanding every side of a collision. */
export function deriveCollectionAliases(nsids: string[]): Map<string, string> {
  const sorted = [...new Set(nsids)].sort();
  const depths = new Map(sorted.map((nsid) => [nsid, 1]));

  for (let pass = 0; pass < 32; pass++) {
    const groups = new Map<string, string[]>();
    for (const nsid of sorted) {
      const candidate = aliasAtDepth(nsid, depths.get(nsid)!);
      const group = groups.get(candidate) ?? [];
      group.push(nsid);
      groups.set(candidate, group);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    if (collisions.length === 0) {
      return new Map(
        sorted.map((nsid) => [nsid, aliasAtDepth(nsid, depths.get(nsid)!)]),
      );
    }
    let expanded = false;
    for (const group of collisions) {
      for (const nsid of group) {
        const max = nsid.split(".").length;
        const depth = depths.get(nsid)!;
        if (depth < max) {
          depths.set(nsid, depth + 1);
          expanded = true;
        }
      }
    }
    if (!expanded) break;
  }

  const used = new Set<string>();
  return new Map(
    sorted.map((nsid) => {
      const base = aliasAtDepth(nsid, nsid.split(".").length);
      let alias = base;
      if (used.has(alias)) {
        alias = `${base}${createHash("sha256").update(nsid).digest("hex").slice(0, 8)}`;
      }
      used.add(alias);
      return [nsid, alias];
    }),
  );
}

function safePath(path: string): boolean {
  try {
    validateFieldName(path);
    return true;
  } catch {
    return false;
  }
}

interface WalkState {
  documents: Map<string, LexiconDoc>;
  queryable: Map<string, QueryableField>;
  skipped: Map<string, SkippedField>;
  references: Map<string, ReferenceCandidate>;
  groupFields: Map<string, GroupFieldCandidate>;
}

function skip(state: WalkState, path: string, reason: SkippedField["reason"]) {
  if (!state.skipped.has(path)) state.skipped.set(path, { path, reason });
}

function addReference(
  state: WalkState,
  candidate: ReferenceCandidate,
): void {
  const existing = state.references.get(candidate.path);
  if (!existing || candidate.kind === "strongRef") {
    state.references.set(candidate.path, candidate);
  }
}

function walkDefinition(
  state: WalkState,
  definition: any,
  path: string,
  contextNsid: string,
  seen: ReadonlySet<string>,
): void {
  if (!definition || typeof definition !== "object") {
    skip(state, path, "unsupported");
    return;
  }

  switch (definition.type) {
    case "string": {
      if (!safePath(path)) {
        skip(state, path, "unsafe-path");
        return;
      }
      if (definition.const !== undefined) {
        skip(state, path, "constant");
        return;
      }
      state.queryable.set(
        path,
        definition.format === "datetime" ? { type: "range" } : {},
      );
      if (definition.format === "at-uri") {
        addReference(state, { path, kind: "at-uri" });
      }
      const values: unknown[] = Array.isArray(definition.enum)
        ? definition.enum
        : Array.isArray(definition.knownValues)
          ? definition.knownValues
          : [];
      const strings = values.filter(
        (value: unknown): value is string => typeof value === "string",
      );
      if (strings.length > 0 && strings.length <= 20) {
        state.groupFields.set(path, {
          path,
          values: [...new Set(strings)].sort(),
        });
      }
      return;
    }
    case "ref": {
      const target = parseLexiconRef(
        definition.ref,
        contextNsid as LexiconDoc["id"],
      );
      const key = `${target.nsid}#${target.defId}`;
      if (seen.has(key)) {
        skip(state, path, "cycle");
        return;
      }
      const document = state.documents.get(target.nsid);
      const resolved = document?.defs[target.defId];
      if (!resolved) {
        skip(state, path, "unsupported");
        return;
      }
      if (target.nsid === STRONG_REF && target.defId === "main") {
        addReference(state, {
          path: `${path}.uri`,
          kind: "strongRef",
          cidPath: `${path}.cid`,
        });
      }
      walkDefinition(
        state,
        resolved,
        path,
        target.nsid,
        new Set([...seen, key]),
      );
      return;
    }
    case "object":
      if (!definition.properties || Object.keys(definition.properties).length === 0) {
        skip(state, path, "object");
        return;
      }
      for (const [name, property] of Object.entries(definition.properties)) {
        walkDefinition(
          state,
          property,
          path ? `${path}.${name}` : name,
          contextNsid,
          seen,
        );
      }
      return;
    case "record":
      walkDefinition(state, definition.record, path, contextNsid, seen);
      return;
    case "array":
      skip(state, path, "array");
      return;
    case "union":
      skip(state, path, "union");
      return;
    case "integer":
      skip(state, path, "integer");
      return;
    case "boolean":
      skip(state, path, "boolean");
      return;
    case "blob":
      skip(state, path, "blob");
      return;
    case "bytes":
      skip(state, path, "bytes");
      return;
    case "cid-link":
      skip(state, path, "cid-link");
      return;
    case "unknown":
      skip(state, path, "unknown");
      return;
    case "token":
      skip(state, path, "token");
      return;
    default:
      skip(state, path, "unsupported");
  }
}

export function analyzeLexiconGraph(graph: LexiconGraph): PrefixAnalysis {
  const aliases = deriveCollectionAliases(graph.roots);
  const collections = graph.roots.map((nsid) => {
    const document = graph.parsed.get(nsid)!;
    const main = document.defs.main as any;
    const state: WalkState = {
      documents: graph.parsed,
      queryable: new Map(),
      skipped: new Map(),
      references: new Map(),
      groupFields: new Map(),
    };
    for (const [name, property] of Object.entries(
      main.record?.properties ?? {},
    )) {
      walkDefinition(state, property, name, nsid, new Set());
    }
    return {
      nsid,
      alias: aliases.get(nsid)!,
      queryable: Object.fromEntries(
        [...state.queryable.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      skipped: [...state.skipped.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      references: [...state.references.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      groupFields: [...state.groupFields.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    } satisfies CollectionAnalysis;
  });
  return { graph, collections };
}
