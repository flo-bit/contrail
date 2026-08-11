import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectPublicService,
  ensureConsumerClientModule,
  ensureConsumerLexiconConfig,
  type ProviderLock,
} from "../src/cli/commands/connect";
import {
  contractFromManifest,
  digestLexiconDocuments,
  digestPublicContract,
  type PublicServiceManifest,
} from "../src/public-service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const endpoint = "https://api.atmo.rsvp";
const method = "atmo.rsvp.event.listRecords";
const methodLexicon = {
  lexicon: 1,
  id: method,
  defs: { main: { type: "query" } },
};
const sourceLexicon = {
  lexicon: 1,
  id: "community.lexicon.calendar.event",
  defs: { main: { type: "record" } },
};
const notifyMethod = "atmo.rsvp.notifyOfUpdate";
const notifyLexicon = {
  lexicon: 1,
  id: notifyMethod,
  defs: { main: { type: "procedure" } },
};

function providerLock(): ProviderLock {
  return {
    format: "contrail.provider-lock",
    version: 1,
    endpoint,
    namespace: "atmo.rsvp",
    contractDigest: `sha256:${"a".repeat(64)}`,
    lexiconDigest: `sha256:${"b".repeat(64)}`,
    methods: [method],
    collections: ["community.lexicon.calendar.event"],
    serviceAuth: {
      type: "atproto-service-auth",
      audience: "did:web:api.atmo.rsvp",
      methods: [{ id: notifyMethod, type: "procedure" }],
    },
    lexiconRoot: "src/contrail/lexicons/api.atmo.rsvp",
  };
}

async function serviceFixture(values = [methodLexicon, sourceLexicon]) {
  const { digest } = await digestLexiconDocuments(values);
  const manifest: PublicServiceManifest = {
    format: "contrail.service",
    version: 1,
    endpoint,
    namespace: "atmo.rsvp",
    contract: { digest: "" },
    lexicons: { url: `${endpoint}/lexicons/${digest}`, digest },
    status: { url: `${endpoint}/status` },
    collections: [
      {
        alias: "event",
        nsid: "community.lexicon.calendar.event",
        methods: [method],
        queryable: [],
        searchable: [],
        relations: [],
        references: [],
      },
    ],
    methods: [method],
    serviceAuth: null,
  };
  manifest.contract.digest = await digestPublicContract(
    contractFromManifest(manifest),
  );
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/contrail")) {
      return Response.json(manifest);
    }
    if (url.includes("/lexicons/")) return Response.json({ lexicons: values });
    return new Response("not found", { status: 404 });
  });
  return { fetcher, manifest, values };
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "contrail-connect-"));
  roots.push(root);
  return root;
}

describe("contrail connect", () => {
  it("creates a default Atcute config without replacing consumer config", async () => {
    const root = await temporaryRoot();
    const generated = await ensureConsumerLexiconConfig({
      root,
      out: "src/contrail/lexicons",
      lock: providerLock(),
    });
    expect(generated.created).toBe(true);
    expect(await readFile(generated.path, "utf8")).toContain(
      'files: ["src/contrail/lexicons/**/*.json"]',
    );
    expect(await readFile(generated.path, "utf8")).toContain(
      'outdir: "src/contrail/types/"',
    );
    expect(await readFile(generated.path, "utf8")).toContain(
      'endpoint: "https://api.atmo.rsvp"',
    );
    expect(await readFile(generated.path, "utf8")).toContain(
      'serviceDid: "did:web:api.atmo.rsvp"',
    );
    expect(await readFile(generated.path, "utf8")).toContain(
      'scope: "rpc?lxm=*&aud=did:web:api.atmo.rsvp"',
    );
    expect(await readFile(generated.path, "utf8")).toContain(
      '"community.lexicon.calendar.event",',
    );
    const updated = await ensureConsumerLexiconConfig({
      root,
      out: "src/contrail/lexicons",
      lock: { ...providerLock(), endpoint: "https://next.example.com" },
    });
    expect(updated.updated).toBe(true);
    expect(await readFile(updated.path, "utf8")).toContain(
      'endpoint: "https://next.example.com"',
    );

    await writeFile(join(root, "lex.config.ts"), "export default { mine: true }");
    await rm(generated.path);
    const existing = await ensureConsumerLexiconConfig({
      root,
      out: "src/other",
      lock: providerLock(),
    });
    expect(existing.created).toBe(false);
    expect(existing.path).toBe(join(root, "lex.config.ts"));
    expect(await readFile(existing.path, "utf8")).toBe(
      "export default { mine: true }",
    );
  });

  it("generates TypeScript or JavaScript client modules without replacing one", async () => {
    const root = await temporaryRoot();
    const fixture = await serviceFixture([
      methodLexicon,
      sourceLexicon,
      notifyLexicon,
    ]);
    fixture.manifest.serviceAuth = {
      type: "atproto-service-auth",
      audience: "did:web:api.atmo.rsvp",
      methods: [{ id: notifyMethod, type: "procedure" }],
    };
    fixture.manifest.contract.digest = await digestPublicContract(
      contractFromManifest(fixture.manifest),
    );
    const { lock } = await connectPublicService({
      endpoint,
      root,
      out: "lexicons/pulled",
      lock: "contrail.lock.json",
      fetcher: fixture.fetcher,
    });

    const generated = await ensureConsumerClientModule({ root, lock });
    expect(generated.created).toBe(true);
    const source = await readFile(generated.path, "utf8");
    expect(source).toContain(
      'import type {} from "./types/index.js"',
    );
    expect(source).toContain(`endpoint: ${JSON.stringify(endpoint)}`);
    expect(source).toContain(
      `contractDigest: ${JSON.stringify(lock.contractDigest)}`,
    );
    expect(source).toContain(
      'serviceDid: "did:web:api.atmo.rsvp"',
    );
    expect(source).toContain(
      'scope: "rpc?lxm=*&aud=did:web:api.atmo.rsvp"',
    );
    expect(source).toContain('"community.lexicon.calendar.event",');
    expect(source).toContain(
      `notifyMethod: ${JSON.stringify(notifyMethod)}`,
    );

    const updated = await ensureConsumerClientModule({
      root,
      lock: { ...lock, endpoint: "https://next.example.com" },
    });
    expect(updated.updated).toBe(true);
    expect(await readFile(updated.path, "utf8")).toContain(
      'endpoint: "https://next.example.com"',
    );

    await writeFile(generated.path, "export const mine = true;\n");
    const existing = await ensureConsumerClientModule({ root, lock });
    expect(existing.created).toBe(false);
    expect(await readFile(existing.path, "utf8")).toBe(
      "export const mine = true;\n",
    );

    const javascript = await ensureConsumerClientModule({
      root,
      file: "client/contrail.js",
      lock,
    });
    expect(javascript.created).toBe(true);
    expect(await readFile(javascript.path, "utf8")).not.toContain(
      "lexicons/index",
    );
  });

  it("verifies and atomically locks a discovered service", async () => {
    const root = await temporaryRoot();
    const { fetcher, manifest, values } = await serviceFixture();

    const result = await connectPublicService({
      endpoint,
      root,
      out: "lexicons/pulled",
      lock: "contrail.lock.json",
      fetcher,
    });

    expect(result.written).toBe(2);
    expect(result.lock).toMatchObject({
      endpoint,
      namespace: "atmo.rsvp",
      contractDigest: manifest.contract.digest,
      lexiconRoot: "lexicons/pulled/api.atmo.rsvp",
    });
    expect(
      JSON.parse(
        await readFile(
          join(
            root,
            "lexicons/pulled/api.atmo.rsvp/atmo/rsvp/event/listRecords.json",
          ),
          "utf8",
        ),
      ),
    ).toEqual(values[0]);
    expect(
      JSON.parse(await readFile(join(root, "contrail.lock.json"), "utf8")),
    ).toEqual(result.lock);

    await writeFile(join(root, "lexicons/pulled/consumer-owned.json"), "keep");
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher,
      }),
    ).rejects.toThrow("rerun with --update");
    await connectPublicService({
      endpoint,
      root,
      out: "lexicons/pulled",
      lock: "contrail.lock.json",
      fetcher,
      update: true,
    });
    expect(
      await readFile(join(root, "lexicons/pulled/consumer-owned.json"), "utf8"),
    ).toBe("keep");
  });

  it("refuses to repoint an existing lock or abandon its owned output", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "contrail.lock.json");
    const fetcher = vi.fn();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        ...providerLock(),
        endpoint: "https://old.example.com",
      })}\n`,
    );

    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "src/contrail/lexicons",
        lock: "contrail.lock.json",
        fetcher,
        update: true,
      }),
    ).rejects.toThrow("remove the existing connection before switching endpoints");
    expect(fetcher).not.toHaveBeenCalled();

    await writeFile(lockPath, `${JSON.stringify(providerLock())}\n`);
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "src/different-lexicons",
        lock: "contrail.lock.json",
        fetcher,
        update: true,
      }),
    ).rejects.toThrow("reuse its output path");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("locks discoverable service-auth methods separately", async () => {
    const root = await temporaryRoot();
    const fixture = await serviceFixture([
      methodLexicon,
      sourceLexicon,
      notifyLexicon,
    ]);
    fixture.manifest.serviceAuth = {
      type: "atproto-service-auth",
      audience: "did:web:api.atmo.rsvp",
      methods: [{ id: notifyMethod, type: "procedure" }],
    };
    fixture.manifest.contract.digest = await digestPublicContract(
      contractFromManifest(fixture.manifest),
    );

    const result = await connectPublicService({
      endpoint,
      root,
      out: "lexicons/pulled",
      lock: "contrail.lock.json",
      fetcher: fixture.fetcher,
    });

    expect(result.lock.methods).toEqual([method]);
    expect(result.lock.serviceAuth).toEqual(fixture.manifest.serviceAuth);
  });

  it("preserves the previous provider and lock when an update fails validation", async () => {
    const root = await temporaryRoot();
    const fixture = await serviceFixture();
    await connectPublicService({
      endpoint,
      root,
      out: "lexicons/pulled",
      lock: "contrail.lock.json",
      fetcher: fixture.fetcher,
    });
    const lockPath = join(root, "contrail.lock.json");
    const documentPath = join(
      root,
      "lexicons/pulled/api.atmo.rsvp/atmo/rsvp/event/listRecords.json",
    );
    const previousLock = await readFile(lockPath, "utf8");
    const previousDocument = await readFile(documentPath, "utf8");
    fixture.manifest.contract.digest = `sha256:${"f".repeat(64)}`;

    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: fixture.fetcher,
        update: true,
      }),
    ).rejects.toThrow("Contract digest mismatch");
    expect(await readFile(lockPath, "utf8")).toBe(previousLock);
    expect(await readFile(documentPath, "utf8")).toBe(previousDocument);
  });

  it("rejects Lexicon and contract digest mismatches", async () => {
    const root = await temporaryRoot();
    const lexiconMismatch = await serviceFixture();
    lexiconMismatch.manifest.lexicons.digest = `sha256:${"0".repeat(64)}`;
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: lexiconMismatch.fetcher,
      }),
    ).rejects.toThrow("Lexicon digest mismatch");

    const contractMismatch = await serviceFixture();
    contractMismatch.manifest.contract.digest = `sha256:${"1".repeat(64)}`;
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: contractMismatch.fetcher,
      }),
    ).rejects.toThrow("Contract digest mismatch");
  });

  it("rejects advertised methods without matching query Lexicons", async () => {
    const root = await temporaryRoot();
    const fixture = await serviceFixture([
      { ...methodLexicon, defs: { main: { type: "procedure" } } },
      sourceLexicon,
    ]);
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: fixture.fetcher,
      }),
    ).rejects.toThrow("matching query Lexicon");
  });

  it("rejects protected methods without matching procedure or query Lexicons", async () => {
    const root = await temporaryRoot();
    const fixture = await serviceFixture([
      methodLexicon,
      sourceLexicon,
      { ...notifyLexicon, defs: { main: { type: "query" } } },
    ]);
    fixture.manifest.serviceAuth = {
      type: "atproto-service-auth",
      audience: "did:web:api.atmo.rsvp",
      methods: [{ id: notifyMethod, type: "procedure" }],
    };
    fixture.manifest.contract.digest = await digestPublicContract(
      contractFromManifest(fixture.manifest),
    );

    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: fixture.fetcher,
      }),
    ).rejects.toThrow("matching procedure Lexicon");
  });

  it("rejects inconsistent method namespaces and collection capabilities", async () => {
    const root = await temporaryRoot();
    const outside = await serviceFixture();
    outside.manifest.methods.push("other.example.read");
    outside.manifest.contract.digest = await digestPublicContract(
      contractFromManifest(outside.manifest),
    );
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: outside.fetcher,
      }),
    ).rejects.toThrow("outside its namespace");

    const unknown = await serviceFixture();
    unknown.manifest.collections[0]!.methods.push("atmo.rsvp.event.getRecord");
    unknown.manifest.contract.digest = await digestPublicContract(
      contractFromManifest(unknown.manifest),
    );
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: unknown.fetcher,
      }),
    ).rejects.toThrow("advertises an unknown method");
  });

  it("rejects cross-origin redirects and bounded request timeouts", async () => {
    const root = await temporaryRoot();
    const redirected = vi.fn(async () => {
      const response = Response.json({});
      Object.defineProperty(response, "url", {
        value: "https://evil.example/",
      });
      return response;
    });
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: redirected,
      }),
    ).rejects.toThrow("redirected to a different origin");

    const hanging = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: hanging,
        timeoutMs: 5,
      }),
    ).rejects.toThrow();
  });

  it("never cleans an output path outside the consumer project", async () => {
    const root = await temporaryRoot();
    const { fetcher } = await serviceFixture();
    await expect(
      connectPublicService({
        endpoint,
        root,
        out: ".",
        lock: "contrail.lock.json",
        fetcher,
      }),
    ).rejects.toThrow("path must stay inside");
  });
});
