import {
  LexiconIterableIndexer,
  LexiconSchemaBuilder,
  lexiconDocumentSchema,
} from "@atproto/lex-document";
import { jsonToLex } from "@atproto/lex-json";
import { l } from "@atproto/lex-schema";
import type { RecordValidationProvider } from "@atmo-dev/contrail";

/** The public Atcute validator does not yet recognize Space AT URIs. Use the
 * pinned alpha validator only for private records; never rewrite Lexicons or
 * weaken at-uri fields to generic strings. CID verification stays in core. */
export function createSpaceRecordValidation(
  lexicons: readonly object[],
  collections: readonly string[],
): {
  ready: Promise<void>;
  validate: RecordValidationProvider;
} {
  const schemas = new Map<string, l.RecordSchema>();
  const ready = (async () => {
    const documents = lexicons.map((document) =>
      lexiconDocumentSchema.parse(document),
    );
    const indexer = new LexiconIterableIndexer(documents);
    const builder = new LexiconSchemaBuilder(indexer);
    // The published snapshot rejects external refs without an explicit hash,
    // including calendar.rsvp's com.atproto.repo.strongRef. Normalize the lookup
    // to its standard implicit #main, without changing any Lexicon document.
    const build = builder.buildFullRef;
    builder.buildFullRef = (ref) =>
      build(ref.includes("#") ? ref : `${ref}#main`);
    try {
      for (const collection of collections) {
        const schema = await builder.buildFullRef(`${collection}#main`);
        if (!(schema instanceof l.RecordSchema))
          throw new TypeError(`${collection} is not a record Lexicon`);
        schemas.set(collection, schema);
      }
      await builder.done();
    } finally {
      await indexer[Symbol.asyncDispose]();
    }
  })();
  // Setup failures are surfaced by the runtime's awaited initialization, not as
  // an unhandled rejection between constructing a Worker and its first request.
  void ready.catch(() => {});
  return {
    ready,
    async validate({ collection, rkey, record }) {
      await ready;
      const schema = schemas.get(collection);
      return (
        !!schema &&
        schema.keySchema.safeValidate(rkey).success &&
        schema.safeValidate(
          jsonToLex(record as Parameters<typeof jsonToLex>[0]),
        ).success
      );
    },
  };
}
