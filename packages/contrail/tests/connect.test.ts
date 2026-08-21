import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectConfigSource,
  connectPublicService,
  ensureConsumerClientModule,
  ensureConsumerLexiconConfig,
  replaceSourceLexicons,
  type ProviderLock,
} from "../src/cli/commands/connect";
import {
  digestLexiconDocuments,
  type PublicServiceAuthContract,
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

function serviceAuthContract(): PublicServiceAuthContract {
  return {
    type: "atproto-service-auth",
    serviceDid: "did:web:api.atmo.rsvp",
    audience: "did:web:api.atmo.rsvp#contrail",
    scope:
      "rpc?aud=did:web:api.atmo.rsvp%23contrail&lxm=atmo.rsvp.notifyOfUpdate",
    methods: [{ id: notifyMethod, type: "procedure" }],
  };
}

function providerLock(): ProviderLock {
  return {
    format: "contrail.provider-lock",
    version: 2,
    endpoint,
    namespace: "atmo.rsvp",
    lexiconDigest: `sha256:${"b".repeat(64)}`,
    methods: [method],
    collections: ["community.lexicon.calendar.event"],
    serviceAuth: serviceAuthContract(),
    lexiconRoot: "src/contrail/lexicons/api.atmo.rsvp",
  };
}

async function serviceFixture(
  values = [methodLexicon, sourceLexicon],
  serviceEndpoint = endpoint,
) {
  const { digest } = await digestLexiconDocuments(values);
  const manifest: PublicServiceManifest = {
    format: "contrail.service",
    version: 2,
    endpoint: serviceEndpoint,
    namespace: "atmo.rsvp",
    lexicons: { url: `${serviceEndpoint}/lexicons/${digest}`, digest },
    status: { url: `${serviceEndpoint}/status` },
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
  it("generates an owned config source without creating a deployment lock", async () => {
    const root = await temporaryRoot();
    const configPath = join(root, "src/contrail.config.ts");
    const sourcePath = join(
      root,
      "lexicons/custom/community/lexicon/calendar/event.json",
    );
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "lexicons/custom/community/lexicon/calendar"), {
      recursive: true,
    });
    await writeFile(
      configPath,
      `export const config = {
  namespace: "atmo.rsvp",
  profiles: [],
  notify: true,
  serviceAuth: {
    audience: "did:web:api.atmo.rsvp#contrail",
    methods: ["notifyOfUpdate"],
  },
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
};\n`,
    );
    await writeFile(sourcePath, `${JSON.stringify(sourceLexicon, null, 2)}\n`);
    for (const id of ["com.atproto.label.defs", "com.atproto.repo.strongRef"]) {
      const path = join(root, "lexicons/custom", ...id.split(".")) + ".json";
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({ lexicon: 1, id, defs: { main: { type: "object", properties: {} } } }, null, 2)}\n`,
      );
    }
    const staleLexicon = join(
      root,
      "src/contrail/lexicons/old-provider/other/example/stale.json",
    );
    await mkdir(join(staleLexicon, ".."), { recursive: true });
    await writeFile(
      staleLexicon,
      `${JSON.stringify({ lexicon: 1, id: "other.example.stale", defs: {} })}\n`,
    );

    const result = await connectConfigSource({
      source: "src/contrail.config.ts",
      root,
      out: "src/contrail/lexicons",
    });

    expect(result.definition).toMatchObject({
      endpoint: "http://127.0.0.1:8787",
      namespace: "atmo.rsvp",
      lexiconRoot: "src/contrail/lexicons/source",
    });
    expect(result.definition).not.toHaveProperty("format");
    await expect(
      readFile(
        join(
          root,
          "src/contrail/lexicons/source/other/example/stale.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.definition.serviceAuth).toEqual(serviceAuthContract());
    expect(result.target.serviceAuth).toBeNull();
    expect(result.target.methods).toContain("atmo.rsvp.notifyOfUpdate");
    await expect(
      readFile(join(root, "contrail.lock.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const generated = await ensureConsumerClientModule({
      root,
      api: result.definition,
      target: result.target,
      notifyMethod: "atmo.rsvp.notifyOfUpdate",
    });
    const source = await readFile(generated.path, "utf8");
    expect(source).toContain("export function createLocalContrailClient");
    expect(source).toContain('endpoint: "http://127.0.0.1:8787"');
    expect(source).not.toContain("contractDigest");

    // SQLite dev mode strips `serviceAuth`, so the local factory stays
    // anonymous rather than asking a real PDS to authorize a localhost service.
    expect(source).not.toContain("serviceDid: contrailApi.serviceDid");
    expect(
      source.slice(source.indexOf("export function createLocalContrailClient")),
    ).not.toContain("scope");

    await rm(join(root, "lexicons/custom"), { recursive: true });
    const deploymentLock = providerLock();
    await writeFile(
      join(root, "contrail.lock.json"),
      `${JSON.stringify(deploymentLock, null, 2)}\n`,
    );
    const reconnected = await connectConfigSource({
      source: ".",
      root,
      out: "src/contrail/lexicons",
    });
    expect(reconnected.target.endpoint).toBe(endpoint);
    expect(
      JSON.parse(await readFile(join(root, "contrail.lock.json"), "utf8")),
    ).toEqual(deploymentLock);

    await writeFile(
      join(root, "contrail.lock.json"),
      `${JSON.stringify({ ...deploymentLock, namespace: "other.example" }, null, 2)}\n`,
    );
    await expect(
      connectConfigSource({
        source: ".",
        root,
        out: "src/contrail/lexicons",
      }),
    ).rejects.toThrow("does not match source namespace atmo.rsvp");
  });

  it("resolves unpublished Lexicons from an external config project root", async () => {
    const workspace = await temporaryRoot();
    const consumerRoot = join(workspace, "consumer");
    const apiRoot = join(workspace, "api");
    await mkdir(join(consumerRoot, "src"), { recursive: true });
    await mkdir(join(apiRoot, "src"), { recursive: true });
    await writeFile(
      join(apiRoot, "src/contrail.config.ts"),
      `export const config = {
  namespace: "atmo.rsvp",
  profiles: [],
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
};\n`,
    );
    for (const document of [
      sourceLexicon,
      {
        lexicon: 1,
        id: "com.atproto.label.defs",
        defs: { main: { type: "object", properties: {} } },
      },
      {
        lexicon: 1,
        id: "com.atproto.repo.strongRef",
        defs: { main: { type: "object", properties: {} } },
      },
    ]) {
      const path =
        join(apiRoot, "lexicons/custom", ...document.id.split(".")) + ".json";
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
    }

    const result = await connectConfigSource({
      source: "../api/src/contrail.config.ts",
      root: consumerRoot,
      out: "src/contrail/lexicons",
    });

    expect(result.configPath).toBe(join(apiRoot, "src/contrail.config.ts"));
    expect(
      JSON.parse(
        await readFile(
          join(
            consumerRoot,
            "src/contrail/lexicons/source/community/lexicon/calendar/event.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ id: sourceLexicon.id });
  });

  it("preserves the prior source bundle when staging fails", async () => {
    const root = await temporaryRoot();
    const outputRoot = join(root, "src/contrail/lexicons");
    const providerRoot = join(outputRoot, "source");
    await mkdir(providerRoot, { recursive: true });
    await writeFile(join(providerRoot, "previous.json"), "previous\n");

    await expect(
      replaceSourceLexicons(outputRoot, "source", [
        { id: "not a valid nsid" } as any,
      ]),
    ).rejects.toThrow("invalid Lexicon NSID");
    expect(await readFile(join(providerRoot, "previous.json"), "utf8")).toBe(
      "previous\n",
    );
  });

  it("connects to loopback HTTP only with an explicit development exception", async () => {
    const root = await temporaryRoot();
    const localEndpoint = "http://127.0.0.1:8787";
    const fixture = await serviceFixture(
      [methodLexicon, sourceLexicon],
      localEndpoint,
    );
    await expect(
      connectPublicService({
        endpoint: localEndpoint,
        root,
        out: "src/contrail/lexicons",
        lock: "contrail.lock.json",
        fetcher: fixture.fetcher,
      }),
    ).rejects.toThrow("must use HTTPS");

    const { lock } = await connectPublicService({
      endpoint: localEndpoint,
      root,
      out: "src/contrail/lexicons",
      lock: "contrail.lock.json",
      fetcher: fixture.fetcher,
      allowInsecureHttp: true,
    });
    expect(lock).toMatchObject({
      endpoint: localEndpoint,
      allowInsecureHttp: true,
    });
    const client = await ensureConsumerClientModule({ root, api: lock });
    expect(await readFile(client.path, "utf8")).toContain(
      "allowInsecureHttp: true",
    );
  });

  it("creates a default Atcute config without replacing consumer config", async () => {
    const root = await temporaryRoot();
    const generated = await ensureConsumerLexiconConfig({
      root,
      out: "src/contrail/lexicons",
      api: providerLock(),
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
    const generatedSource = await readFile(generated.path, "utf8");
    expect(generatedSource).toContain(
      'serviceDid: "did:web:api.atmo.rsvp"',
    );
    expect(generatedSource).toContain(
      'serviceAudience: "did:web:api.atmo.rsvp#contrail"',
    );
    expect(generatedSource).toContain(
      'scope: "rpc?aud=did:web:api.atmo.rsvp%23contrail&lxm=atmo.rsvp.notifyOfUpdate"',
    );
    expect(generatedSource).toContain(
      'protectedMethods: [\n      "atmo.rsvp.notifyOfUpdate",',
    );
    expect(await readFile(generated.path, "utf8")).toContain(
      '"community.lexicon.calendar.event",',
    );

    // An anonymous provider omits the keys rather than spelling them as nulls;
    // this block is reference material consumers paste into their own client.
    const anonymousRoot = await temporaryRoot();
    const anonymous = await ensureConsumerLexiconConfig({
      root: anonymousRoot,
      out: "src/contrail/lexicons",
      api: { ...providerLock(), serviceAuth: null },
    });
    const anonymousSource = await readFile(anonymous.path, "utf8");
    expect(anonymousSource).not.toContain("null");
    for (const key of [
      "serviceDid",
      "serviceAudience",
      "scope",
      "protectedMethods",
    ]) {
      expect(anonymousSource).not.toContain(key);
    }

    const updated = await ensureConsumerLexiconConfig({
      root,
      out: "src/contrail/lexicons",
      api: { ...providerLock(), collections: ["source.example.record"] },
      target: {
        ...providerLock(),
        endpoint: "https://next.example.com",
        collections: ["deployed.example.record"],
      },
    });
    expect(updated.updated).toBe(true);
    expect(await readFile(updated.path, "utf8")).toContain(
      'endpoint: "https://next.example.com"',
    );
    expect(await readFile(updated.path, "utf8")).toContain(
      '"deployed.example.record",',
    );
    expect(await readFile(updated.path, "utf8")).not.toContain(
      '"source.example.record",',
    );

    await writeFile(
      join(root, "lex.config.ts"),
      "export default { mine: true }",
    );
    await rm(generated.path);
    const existing = await ensureConsumerLexiconConfig({
      root,
      out: "src/other",
      api: providerLock(),
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
    fixture.manifest.serviceAuth = serviceAuthContract();
    const { lock } = await connectPublicService({
      endpoint,
      root,
      out: "lexicons/pulled",
      lock: "contrail.lock.json",
      fetcher: fixture.fetcher,
    });

    const generated = await ensureConsumerClientModule({ root, api: lock });
    expect(generated.created).toBe(true);
    const source = await readFile(generated.path, "utf8");
    expect(source).toContain('import type {} from "./types/index.js"');
    expect(source).toContain(`endpoint: ${JSON.stringify(endpoint)}`);
    expect(source).not.toContain("contractDigest");
    expect(source).toContain("export function createLocalContrailClient");
    expect(source).toContain('serviceDid: "did:web:api.atmo.rsvp"');
    expect(source).toContain(
      'serviceAudience: "did:web:api.atmo.rsvp#contrail"',
    );
    expect(source).toContain(
      'scope: "rpc?aud=did:web:api.atmo.rsvp%23contrail&lxm=atmo.rsvp.notifyOfUpdate"',
    );
    expect(source).toContain(
      'protectedMethods: [\n    "atmo.rsvp.notifyOfUpdate",',
    );
    expect(source).toContain('"community.lexicon.calendar.event",');
    expect(source).toContain(`notifyMethod: ${JSON.stringify(notifyMethod)}`);

    const updated = await ensureConsumerClientModule({
      root,
      api: { ...lock, endpoint: "https://next.example.com" },
    });
    expect(updated.updated).toBe(true);
    expect(await readFile(updated.path, "utf8")).toContain(
      'endpoint: "https://next.example.com"',
    );

    await writeFile(generated.path, "export const mine = true;\n");
    const existing = await ensureConsumerClientModule({ root, api: lock });
    expect(existing.created).toBe(false);
    expect(await readFile(existing.path, "utf8")).toBe(
      "export const mine = true;\n",
    );

    const javascript = await ensureConsumerClientModule({
      root,
      file: "client/contrail.js",
      api: lock,
    });
    expect(javascript.created).toBe(true);
    expect(await readFile(javascript.path, "utf8")).not.toContain(
      "lexicons/index",
    );
  });

  it("keeps default target notifications separate from the source API", async () => {
    const root = await temporaryRoot();
    const sourceOnlyCollection = "source.example.newRecord";
    const deployedCollection = "community.lexicon.calendar.event";
    const sourceWithoutNotify = {
      ...providerLock(),
      collections: [sourceOnlyCollection],
      serviceAuth: null,
    };
    const deployedWithNotify = providerLock();
    const generated = await ensureConsumerClientModule({
      root,
      file: "src/contrail/source-target.ts",
      api: sourceWithoutNotify,
      target: deployedWithNotify,
    });
    const source = await readFile(generated.path, "utf8");
    const apiBlock = source.slice(
      source.indexOf("export const contrailApi"),
      source.indexOf("export const contrailTarget"),
    );
    const targetBlock = source.slice(
      source.indexOf("export const contrailTarget"),
      source.indexOf("export const contrailMethods"),
    );
    expect(apiBlock).toContain(sourceOnlyCollection);
    expect(apiBlock).toContain("notifyMethod: null");
    expect(targetBlock).toContain(deployedCollection);
    expect(targetBlock).not.toContain(sourceOnlyCollection);
    expect(targetBlock).toContain(`notifyMethod: ${JSON.stringify(notifyMethod)}`);
    expect(source).toContain(
      "collections: target.collections ?? contrailApi.collections",
    );

    const targetWithoutNotify = {
      ...providerLock(),
      collections: [deployedCollection],
      serviceAuth: null,
    };
    const sourceWithNotify = {
      ...providerLock(),
      collections: [sourceOnlyCollection],
    };
    const inverse = await ensureConsumerClientModule({
      root,
      file: "src/contrail/inverse-target.ts",
      api: sourceWithNotify,
      target: targetWithoutNotify,
    });
    const inverseSource = await readFile(inverse.path, "utf8");
    const inverseTarget = inverseSource.slice(
      inverseSource.indexOf("export const contrailTarget"),
      inverseSource.indexOf("export const contrailMethods"),
    );
    expect(inverseTarget).toContain(deployedCollection);
    expect(inverseTarget).not.toContain(sourceOnlyCollection);
    expect(inverseTarget).toContain("notifyMethod: null");
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
      lexiconDigest: manifest.lexicons.digest,
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

  it("rejects v1 locks, repointing, and abandoned owned output", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "contrail.lock.json");
    const fetcher = vi.fn();
    await writeFile(
      lockPath,
      `${JSON.stringify({ ...providerLock(), version: 1 })}\n`,
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
    ).rejects.toThrow("unsupported version 1");

    // A v2 lock written before exact audiences existed needs the same remedy
    // as a v1 lock, so it must not fall through to the generic message.
    await writeFile(
      lockPath,
      `${JSON.stringify({
        ...providerLock(),
        serviceAuth: {
          type: "atproto-service-auth",
          audience: "did:web:api.atmo.rsvp",
          methods: [{ id: notifyMethod, type: "procedure" }],
        },
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
    ).rejects.toThrow("predates exact service-auth audiences");

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
    ).rejects.toThrow(
      "remove the existing connection before switching endpoints",
    );
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
    fixture.manifest.serviceAuth = serviceAuthContract();

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
    fixture.manifest.methods.push("other.example.read");

    await expect(
      connectPublicService({
        endpoint,
        root,
        out: "lexicons/pulled",
        lock: "contrail.lock.json",
        fetcher: fixture.fetcher,
        update: true,
      }),
    ).rejects.toThrow("outside its namespace");
    expect(await readFile(lockPath, "utf8")).toBe(previousLock);
    expect(await readFile(documentPath, "utf8")).toBe(previousDocument);
  });

  it("rejects Lexicon digest mismatches", async () => {
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
    fixture.manifest.serviceAuth = serviceAuthContract();

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
