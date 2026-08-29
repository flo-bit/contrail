import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/cli-config";
import {
  analyzeLexiconGraph,
  buildLexiconGraph,
  deriveCollectionAliases,
} from "../src/cli/init/analyze";
import type {
  PrefixImport,
  VerifiedLexiconDocument,
} from "../src/cli/init/registry";
import { createInitArtifacts } from "../src/cli/init/render";
import { writeInitArtifacts } from "../src/cli/init/write";

const fixtureRoot = resolve("../../apps/atmo-rsvp/lexicons/pulled");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function value(nsid: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixtureRoot, ...nsid.split(".")) + ".json", "utf8"),
  ) as Record<string, unknown>;
}

function verified(nsid: string): VerifiedLexiconDocument {
  return {
    id: nsid,
    authorityDid: "did:plc:authority",
    uri: `at://did:plc:authority/com.atproto.lexicon.schema/${nsid}`,
    cid: `cid-${nsid}`,
    value: value(nsid),
    verifiedAt: "2026-08-29T00:00:00.000Z",
    verifiedUntil: "2099-08-29T00:00:00.000Z",
  };
}

function prefixImport(): PrefixImport {
  return {
    api: "https://lex.atmo.tools",
    prefix: "community.lexicon.calendar.",
    snapshot: "snapshot",
    partial: false,
    verification: {
      candidates: 2,
      verified: 2,
      pending: 0,
      stale: 0,
      temporaryFailure: 0,
      unresolved: 0,
      invalid: 0,
      settled: true,
      allVerified: true,
    },
    indexing: {
      available: true,
      relayDiscoveryComplete: true,
      backfillsPending: 0,
      backfillsExhausted: 0,
      settled: true,
      complete: true,
    },
    documents: [
      verified("community.lexicon.calendar.event"),
      verified("community.lexicon.calendar.rsvp"),
    ],
  };
}

describe("Lexicon prefix analysis", () => {
  it("closes dependencies and derives safe calendar query fields", async () => {
    const graph = await buildLexiconGraph(prefixImport(), async (nsid) =>
      verified(nsid),
    );
    const analysis = analyzeLexiconGraph(graph);

    expect(graph.roots).toEqual([
      "community.lexicon.calendar.event",
      "community.lexicon.calendar.rsvp",
    ]);
    expect(graph.documents.map((document) => document.id)).toContain(
      "com.atproto.repo.strongRef",
    );
    const event = analysis.collections.find(
      (collection) => collection.alias === "event",
    )!;
    const rsvp = analysis.collections.find(
      (collection) => collection.alias === "rsvp",
    )!;
    expect(event.queryable).toEqual({
      createdAt: { type: "range" },
      description: {},
      endsAt: { type: "range" },
      mode: {},
      name: {},
      startsAt: { type: "range" },
      status: {},
    });
    expect(event.skipped).toEqual(
      expect.arrayContaining([
        { path: "locations", reason: "array" },
        { path: "uris", reason: "array" },
      ]),
    );
    expect(rsvp.queryable).toEqual({
      status: {},
      "subject.cid": {},
      "subject.uri": {},
    });
    expect(rsvp.references).toContainEqual({
      path: "subject.uri",
      kind: "strongRef",
      cidPath: "subject.cid",
    });
    expect(rsvp.groupFields).toContainEqual({
      path: "status",
      values: [
        "community.lexicon.calendar.rsvp#going",
        "community.lexicon.calendar.rsvp#interested",
        "community.lexicon.calendar.rsvp#notgoing",
      ],
    });
  });

  it("expands colliding final segments deterministically", () => {
    expect(
      Object.fromEntries(
        deriveCollectionAliases([
          "com.example.feed.post",
          "com.example.chat.post",
          "com.example.actor.profile",
        ]),
      ),
    ).toEqual({
      "com.example.actor.profile": "profile",
      "com.example.chat.post": "chatPost",
      "com.example.feed.post": "feedPost",
    });
  });

  it("renders explicit references and writes a validated pinned project", async () => {
    const graph = await buildLexiconGraph(prefixImport(), async (nsid) =>
      verified(nsid),
    );
    const analysis = analyzeLexiconGraph(graph);
    const artifacts = createInitArtifacts("api.example.calendar", analysis, [
      {
        source: "rsvp",
        path: "subject.uri",
        target: "event",
        name: "event",
        inverse: { name: "rsvps", groupBy: "status" },
      },
    ]);
    const root = await mkdtemp(join(tmpdir(), "contrail-prefix-init-"));
    temporaryRoots.push(root);
    const written = await writeInitArtifacts(root, artifacts);
    const config = await loadConfig(written.configPath);

    expect(config).toMatchObject({
      namespace: "api.example.calendar",
      profiles: [],
      collections: {
        event: {
          validate: true,
          relations: {
            rsvps: {
              collection: "rsvp",
              field: "subject.uri",
              groupBy: "status",
              groups: {
                going: "community.lexicon.calendar.rsvp#going",
                interested:
                  "community.lexicon.calendar.rsvp#interested",
                notgoing: "community.lexicon.calendar.rsvp#notgoing",
              },
            },
          },
        },
        rsvp: {
          references: {
            event: { collection: "event", field: "subject.uri" },
          },
        },
      },
    });
    expect(
      JSON.parse(await readFile(written.lockPath, "utf8")),
    ).toMatchObject({
      format: "contrail.lexicon-import",
      version: 1,
      roots: graph.roots,
    });
    expect(
      await readFile(
        join(
          written.pinnedRoot,
          "com",
          "atproto",
          "repo",
          "strongRef.json",
        ),
        "utf8",
      ),
    ).toContain('"com.atproto.repo.strongRef"');
  });
});
