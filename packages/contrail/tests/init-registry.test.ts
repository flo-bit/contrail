import { describe, expect, it } from "vitest";
import {
  fetchExactLexicon,
  importLexiconPrefix,
  LexiconRegistryError,
  type VerifiedLexiconDocument,
} from "../src/cli/init/registry";

const prefix = "com.example.";

function document(id: string): VerifiedLexiconDocument {
  return {
    id,
    authorityDid: "did:plc:authority",
    uri: `at://did:plc:authority/com.atproto.lexicon.schema/${id}`,
    cid: `cid-${id}`,
    value: {
      lexicon: 1,
      id,
      defs: {
        main: {
          type: "record",
          key: "tid",
          record: { type: "object", properties: {} },
        },
      },
    },
    verifiedAt: "2026-08-29T00:00:00.000Z",
    verifiedUntil: "2099-08-29T00:00:00.000Z",
  };
}

function page(options: {
  documents?: VerifiedLexiconDocument[];
  cursor?: string;
  snapshot?: string;
  allVerified?: boolean;
  settled?: boolean;
  indexingComplete?: boolean;
}) {
  const documents = options.documents ?? [];
  const allVerified = options.allVerified ?? true;
  const settled = options.settled ?? true;
  return {
    prefix,
    verified: true,
    snapshot: options.snapshot ?? "stable",
    lexicons: documents,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    verification: {
      candidates: allVerified ? documents.length : documents.length + 1,
      verified: documents.length,
      pending: settled ? 0 : 1,
      stale: 0,
      temporaryFailure: 0,
      unresolved: settled && !allVerified ? 1 : 0,
      invalid: 0,
      settled,
      allVerified,
    },
    indexing: {
      available: true,
      relayDiscoveryComplete: true,
      backfillsPending: 0,
      backfillsExhausted: 0,
      settled: options.indexingComplete ?? true,
      complete: options.indexingComplete ?? true,
    },
  };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

describe("atmo Lexicon registry client", () => {
  it("paginates one verified snapshot", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return url.searchParams.has("cursor")
        ? json(page({ documents: [document("com.example.two")] }))
        : json(
            page({
              documents: [document("com.example.one")],
              cursor: "next",
            }),
          );
    };

    const result = await importLexiconPrefix(prefix, {
      fetcher,
      timeoutMs: 5_000,
    });
    expect(result.documents.map((item) => item.id)).toEqual([
      "com.example.one",
      "com.example.two",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.origin).toBe("https://lex.atmo.tools");
    expect(requests[0]!.searchParams.get("refresh")).toBe("true");
  });

  it("discards pages and restarts after SnapshotChanged", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async (input) => {
      requests++;
      const url = new URL(String(input));
      if (requests === 1) {
        return json(
          page({
            documents: [document("com.example.old")],
            cursor: "old-next",
            snapshot: "old",
          }),
        );
      }
      if (requests === 2) return json({ error: "SnapshotChanged" }, 409);
      return json(
        page({
          documents: [document("com.example.new")],
          snapshot: "new",
        }),
      );
    };

    const result = await importLexiconPrefix(prefix, {
      fetcher,
      timeoutMs: 5_000,
      sleep: async () => {},
    });
    expect(result.documents.map((item) => item.id)).toEqual([
      "com.example.new",
    ]);
    expect(requests).toBe(3);
  });

  it("fails a settled but incomplete verification unless partial is allowed", async () => {
    const fetcher: typeof fetch = async () =>
      json(
        page({
          documents: [document("com.example.one")],
          allVerified: false,
          settled: true,
        }),
      );

    await expect(
      importLexiconPrefix(prefix, { fetcher, timeoutMs: 5_000 }),
    ).rejects.toMatchObject<Partial<LexiconRegistryError>>({
      code: "IncompleteVerification",
    });
    await expect(
      importLexiconPrefix(prefix, {
        fetcher,
        timeoutMs: 5_000,
        allowPartial: true,
      }),
    ).resolves.toMatchObject({ partial: true });
  });

  it("fails settled exhausted catalog indexing without waiting", async () => {
    const fetcher: typeof fetch = async () => {
      const response = page({
        documents: [document("com.example.one")],
        indexingComplete: false,
      });
      response.indexing.settled = true;
      response.indexing.backfillsExhausted = 1;
      return json(response);
    };
    await expect(
      importLexiconPrefix(prefix, { fetcher, timeoutMs: 5_000 }),
    ).rejects.toMatchObject<Partial<LexiconRegistryError>>({
      code: "IncompleteIndexing",
    });
  });

  it("resolves an exact unobserved dependency after a pending response", async () => {
    const nsid = "com.example.dependency";
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests++;
      return requests === 1
        ? json(
            {
              error: "VerificationPending",
              id: nsid,
              status: "pending",
              retryAt: "2026-08-29T00:00:00.000Z",
            },
            202,
            { "retry-after": "1" },
          )
        : json(document(nsid));
    };

    await expect(
      fetchExactLexicon(nsid, {
        fetcher,
        timeoutMs: 5_000,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ id: nsid });
    expect(requests).toBe(2);
  });

  it("rejects raw or malformed registry data", async () => {
    const fetcher: typeof fetch = async () =>
      json({ ...page({ documents: [] }), verified: false });
    await expect(
      importLexiconPrefix(prefix, { fetcher, timeoutMs: 5_000 }),
    ).rejects.toMatchObject<Partial<LexiconRegistryError>>({
      code: "InvalidResponse",
    });
  });
});
