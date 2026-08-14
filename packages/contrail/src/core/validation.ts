import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import {
  findExternalReferences,
  lexiconDoc,
  parseLexiconRef,
  type LexiconDoc,
} from "@atcute/lexicon-doc";
import { RecordValidator } from "@atcute/lexicon-doc/validations";
import type { Nsid } from "@atcute/lexicons";
import { isRecordKey } from "@atcute/lexicons/syntax";
import { parse as parseValibot } from "valibot";
import type { ContrailConfig, IngestEvent } from "./types";

export type RecordValidationFailure =
  | "lexicon_validation"
  | "cid_mismatch"
  | "cid_encoding"
  | "missing_cid";

interface ValidationContext {
  validators: Map<string, RecordValidator>;
  strict: boolean;
  verifyCid: boolean;
  allowCidlessSources: ReadonlySet<string>;
}

const DEFAULT_CIDLESS_SOURCES = ["local", "legacy-caller", "constellation"];
const contexts = new WeakMap<ContrailConfig, ValidationContext>();
const runtimeLexicons = new WeakMap<ContrailConfig, LexiconDoc[]>();

/** Bind the exact build/runtime Lexicon bundle used by collection-level
 * validation without making policy configuration import generated files. */
export function bindRecordValidationLexicons(
  config: ContrailConfig,
  lexicons: readonly object[],
): void {
  runtimeLexicons.set(config, [...lexicons] as LexiconDoc[]);
  contexts.delete(config);
}

function documentMap(lexicons: LexiconDoc[]): Record<string, LexiconDoc> {
  const documents: Record<string, LexiconDoc> = {};
  for (const input of lexicons) {
    let document: LexiconDoc;
    try {
      document = parseValibot(lexiconDoc, input);
    } catch {
      throw new Error("runtime validation bundle contains an invalid Lexicon document");
    }
    if (documents[document.id]) {
      throw new Error(`duplicate validation Lexicon document: ${document.id}`);
    }
    documents[document.id] = document;
  }
  return documents;
}

function requireReferencedDocuments(
  documents: Record<string, LexiconDoc>,
  roots: Iterable<string>,
): void {
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const nsid = pending.pop()!;
    if (visited.has(nsid)) continue;
    visited.add(nsid);
    const document = documents[nsid];
    if (!document) {
      throw new Error(`missing validation Lexicon document: ${nsid}`);
    }
    for (const reference of findExternalReferences(document)) {
      const parsed = parseLexiconRef(reference, document.id);
      const referenced = documents[parsed.nsid];
      if (!referenced) {
        throw new Error(`missing validation Lexicon document: ${parsed.nsid}`);
      }
      if (!referenced.defs[parsed.defId]) {
        throw new Error(
          `missing validation Lexicon definition: ${parsed.nsid}#${parsed.defId}`,
        );
      }
      if (!visited.has(parsed.nsid)) pending.push(parsed.nsid);
    }
  }
}

/** Build and cache one Atcute RecordValidator for each collection that
 * explicitly opts in with `validate: true`. */
export function prepareRecordValidation(
  config: ContrailConfig,
): ValidationContext | null {
  const collections = new Set(
    Object.entries(config.collections)
      .filter(([, collection]) => collection.validate === true)
      .map(([shortName, collection]) => collection.collection ?? shortName),
  );
  if (collections.size === 0) return null;

  const cached = contexts.get(config);
  if (cached) return cached;
  const validation = config.validation;
  const lexicons = runtimeLexicons.get(config);
  if (!lexicons) {
    throw new Error(
      "validated collections require a runtime Lexicon bundle; pass generated `lexicons` to the runtime",
    );
  }

  const documents = documentMap(lexicons);
  requireReferencedDocuments(documents, collections);

  const validators = new Map<string, RecordValidator>();
  for (const collection of collections) {
    validators.set(
      collection,
      new RecordValidator(documents, collection as Nsid),
    );
  }

  const context: ValidationContext = {
    validators,
    strict: validation?.strict !== false,
    verifyCid: validation?.verifyCid !== false,
    allowCidlessSources: new Set(
      validation?.allowCidlessSources ?? DEFAULT_CIDLESS_SOURCES,
    ),
  };
  contexts.set(config, context);
  return context;
}

/** Validate one parsed create/update before filters or projection. */
export async function validateCanonicalRecord(
  config: ContrailConfig,
  event: IngestEvent,
  record: Record<string, unknown>,
): Promise<RecordValidationFailure | null> {
  const context = prepareRecordValidation(config);
  if (!context) return null;

  const validator = context.validators.get(event.collection);
  if (!validator) return null;
  if (!isRecordKey(event.rkey)) return "lexicon_validation";
  try {
    const result = validator.try(
      { key: event.rkey, object: record },
      { strict: context.strict },
    );
    if (!result.ok) return "lexicon_validation";
  } catch {
    return "lexicon_validation";
  }
  if (!context.verifyCid) return null;

  if (event.cid === null) {
    const sourceId = event.source?.id ?? "legacy-caller";
    return context.allowCidlessSources.has(sourceId) ? null : "missing_cid";
  }

  try {
    const actual = toString(await create(CODEC_DCBOR, encode(record)));
    return actual === event.cid ? null : "cid_mismatch";
  } catch {
    return "cid_encoding";
  }
}
