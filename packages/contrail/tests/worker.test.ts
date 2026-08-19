import { describe, it, expect, vi } from "vitest";
import { createWorker } from "../src/worker";
import { Contrail } from "../src/contrail";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { saveCursor, type ContrailConfig } from "../src/index";

const MINIMAL_CONFIG: ContrailConfig = {
  namespace: "com.example",
  profiles: [],
  orderedSource: { source: "jetstream", epoch: "worker-test" },
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { startsAt: { type: "range" } },
    },
  },
};

function queryLexicons(...ids: string[]) {
  return ids.map((id) => ({
    lexicon: 1,
    id,
    defs: { main: { type: "query" } },
  }));
}

function procedureLexicon(id: string) {
  return { lexicon: 1, id, defs: { main: { type: "procedure" } } };
}

const MINIMAL_PUBLIC_LEXICONS = queryLexicons(
  "com.example.getCursor",
  "com.example.event.getRecord",
  "com.example.event.listRecords",
);

describe("createWorker", () => {
  it("binds the deployment bundle only for opted-in collection validation", () => {
    const config: ContrailConfig = {
      ...MINIMAL_CONFIG,
      collections: {
        event: {
          ...MINIMAL_CONFIG.collections.event!,
          validate: true,
        },
      },
    };
    const recordLexicon = {
      lexicon: 1,
      id: "community.lexicon.calendar.event",
      defs: {
        main: {
          type: "record",
          key: "any",
          record: { type: "object", properties: {} },
        },
      },
    };

    expect(() => createWorker(config, { lexicons: [recordLexicon] })).not.toThrow();
    expect(() => createWorker(config, { lexicons: [] })).toThrow(
      "missing validation Lexicon document",
    );
    expect(() =>
      createWorker({
        ...config,
        collections: {
          event: { ...config.collections.event!, validate: false },
        },
      }),
    ).not.toThrow();
  });

  it("returns an object with fetch + scheduled handlers", () => {
    const worker = createWorker(MINIMAL_CONFIG);
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("inits the DB schema lazily on the first fetch (and only once)", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG);
    const env = { DB: db };

    // Before first fetch: schema not present yet.
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursor'",
      )
      .first<{ name: string }>();
    expect(tables).toBeNull();

    await worker.fetch(new Request("http://localhost/health"), env);

    // After first fetch: schema present.
    const after = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursor'",
      )
      .first<{ name: string }>();
    expect(after?.name).toBe("cursor");

    // Second fetch shouldn't re-init (idempotent regardless, but verify
    // onInit fires only once per isolate via a probe).
    const onInit = vi.fn();
    const w2 = createWorker(MINIMAL_CONFIG, { onInit });
    await w2.fetch(new Request("http://localhost/health"), env);
    await w2.fetch(new Request("http://localhost/health"), env);
    await w2.fetch(new Request("http://localhost/health"), env);
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  it("respects a custom binding name", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG, { binding: "MY_DB" });
    const env = { MY_DB: db };

    const res = await worker.fetch(new Request("http://localhost/health"), env);
    expect(res.status).toBe(200);
  });

  it("serves /xrpc/<ns>.lexicons when lexicons are passed", async () => {
    const db = createSqliteDatabase(":memory:");
    const lexicons = [{ lexicon: 1, id: "com.example.foo" }];
    const worker = createWorker(MINIMAL_CONFIG, { lexicons });
    const env = { DB: db };

    const res = await worker.fetch(
      new Request("http://localhost/xrpc/com.example.lexicons"),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lexicons });
  });

  it("does not serve /xrpc/<ns>.lexicons when lexicons are omitted", async () => {
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(MINIMAL_CONFIG);
    const env = { DB: db };

    const res = await worker.fetch(
      new Request("http://localhost/xrpc/com.example.lexicons"),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("serves deterministic public discovery and stable Lexicons", async () => {
    const db = createSqliteDatabase(":memory:");
    const lexicons = MINIMAL_PUBLIC_LEXICONS;
    const worker = createWorker(MINIMAL_CONFIG, {
      lexicons,
      publicService: { endpoint: "https://api.example.com" },
    });
    const env = { DB: db };

    const manifestResponse = await worker.fetch(
      new Request("https://api.example.com/.well-known/contrail"),
      env,
    );
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("access-control-allow-origin")).toBe(
      "*",
    );
    const manifest = await manifestResponse.json<any>();
    expect(manifest).toMatchObject({
      format: "contrail.service",
      version: 2,
      endpoint: "https://api.example.com",
      namespace: "com.example",
      lexicons: {
        url: expect.stringMatching(
          /^https:\/\/api\.example\.com\/lexicons\/sha256:[0-9a-f]{64}$/,
        ),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      methods: [
        "com.example.event.getRecord",
        "com.example.event.listRecords",
        "com.example.getCursor",
      ],
      collections: expect.arrayContaining([
        {
          alias: "event",
          nsid: "community.lexicon.calendar.event",
          methods: [
            "com.example.event.getRecord",
            "com.example.event.listRecords",
          ],
          queryable: ["startsAt"],
          searchable: [],
          relations: [],
          references: [],
        },
      ]),
    });
    expect(manifest.contract).toBeUndefined();
    expect(manifestResponse.headers.get("etag")).toBeNull();
    expect(manifest.lexicons.url).toBe(
      `https://api.example.com/lexicons/${manifest.lexicons.digest}`,
    );

    const lexiconResponse = await worker.fetch(
      new Request("https://api.example.com/lexicons"),
      env,
    );
    expect(lexiconResponse.status).toBe(200);
    expect(await lexiconResponse.json()).toEqual({
      lexicons: [...lexicons].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
    expect(lexiconResponse.headers.get("etag")).toBe(
      `"${manifest.lexicons.digest}"`,
    );
    const immutableLexicons = await worker.fetch(
      new Request(manifest.lexicons.url),
      env,
    );
    expect(immutableLexicons.status).toBe(200);
    expect(immutableLexicons.headers.get("cache-control")).toContain(
      "immutable",
    );

    const statusResponse = await worker.fetch(
      new Request("https://api.example.com/status"),
      env,
    );
    const status = await statusResponse.json<any>();
    expect(status).toMatchObject({
      serving: "ready",
      freshness: { last_event_at: null, seconds_ago: null },
    });
    expect(status.ingestion).toBeUndefined();
    expect(statusResponse.headers.get("cache-control")).toContain("max-age=15");
    expect(JSON.stringify(status)).not.toContain("cursor");

    const emptyCursor = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.getCursor"),
      env,
    );
    expect(await emptyCursor.json()).toEqual({});

    await saveCursor(db, 1234, MINIMAL_CONFIG.orderedSource);
    const cursorResponse = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.getCursor"),
      env,
    );
    expect(cursorResponse.status).toBe(200);
    expect(await cursorResponse.json()).toMatchObject({
      position: {
        source: "jetstream",
        epoch: "worker-test",
        cursor: "1234",
      },
    });
    expect(
      (
        await worker.fetch(
          new Request("https://api.example.com/xrpc/com.example.getOverview"),
          env,
        )
      ).status,
    ).toBe(404);
  });

  it("publishes a coherent fragmented service audience and DID document", async () => {
    const config: ContrailConfig = {
      ...MINIMAL_CONFIG,
      notify: true,
      serviceAuth: {
        audience: "did:web:api.example.com#contrail",
        methods: ["notifyOfUpdate"],
      },
    };
    const worker = createWorker(config, {
      lexicons: [
        ...MINIMAL_PUBLIC_LEXICONS,
        procedureLexicon("com.example.notifyOfUpdate"),
      ],
      publicService: { endpoint: "https://api.example.com" },
    });
    const env = { DB: createSqliteDatabase(":memory:") };

    const manifest = await (
      await worker.fetch(
        new Request("https://api.example.com/.well-known/contrail"),
        env,
      )
    ).json<any>();
    expect(manifest.serviceAuth).toEqual({
      type: "atproto-service-auth",
      serviceDid: "did:web:api.example.com",
      audience: "did:web:api.example.com#contrail",
      scope:
        "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.notifyOfUpdate",
      methods: [
        { id: "com.example.notifyOfUpdate", type: "procedure" },
      ],
    });

    const response = await worker.fetch(
      new Request("https://api.example.com/.well-known/did.json"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/did+ld+json",
    );
    expect(await response.json()).toEqual({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: "did:web:api.example.com",
      service: [
        {
          id: "did:web:api.example.com#contrail",
          type: "ContrailService",
          serviceEndpoint: "https://api.example.com",
        },
      ],
    });
  });

  it("rejects an automatically hosted did:web audience for another origin", () => {
    const config: ContrailConfig = {
      ...MINIMAL_CONFIG,
      notify: true,
      serviceAuth: {
        audience: "did:web:other.example.com#contrail",
        methods: ["notifyOfUpdate"],
      },
    };
    expect(() =>
      createWorker(config, {
        lexicons: [
          ...MINIMAL_PUBLIC_LEXICONS,
          procedureLexicon("com.example.notifyOfUpdate"),
        ],
        publicService: { endpoint: "https://api.example.com" },
      }),
    ).toThrow("resolves its DID document");
  });

  it("leaves externally managed did:plc audiences without a local DID route", async () => {
    const config: ContrailConfig = {
      ...MINIMAL_CONFIG,
      notify: true,
      serviceAuth: {
        audience: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#contrail",
        methods: ["notifyOfUpdate"],
      },
    };
    const worker = createWorker(config, {
      lexicons: [
        ...MINIMAL_PUBLIC_LEXICONS,
        procedureLexicon("com.example.notifyOfUpdate"),
      ],
      publicService: { endpoint: "https://api.example.com" },
    });
    const response = await worker.fetch(
      new Request("https://api.example.com/.well-known/did.json"),
      { DB: createSqliteDatabase(":memory:") },
    );
    expect(response.status).toBe(404);
  });

  it("preserves the legacy cursor response without an ordered source", async () => {
    const config: ContrailConfig = {
      ...MINIMAL_CONFIG,
      orderedSource: undefined,
    };
    const db = createSqliteDatabase(":memory:");
    const worker = createWorker(config);
    const env = { DB: db };
    await worker.fetch(new Request("https://api.example.com/health"), env);
    await saveCursor(db, 1_234_000);

    const response = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.getCursor"),
      env,
    );
    expect(await response.json()).toMatchObject({
      time_us: 1_234_000,
      date: new Date(1234).toISOString(),
    });
  });

  it("keeps profiles, feeds, custom queries, and configured notify routes", async () => {
    const config: ContrailConfig = {
      ...MINIMAL_CONFIG,
      profiles: [{ collection: "com.example.profile", shortName: "profile" }],
      feeds: { network: { targets: ["event"] } },
      notify: "secret",
      collections: {
        event: {
          ...MINIMAL_CONFIG.collections.event,
          queries: {
            featured: async () => Response.json({ records: [] }),
          },
        },
      },
    };
    const lexicons = queryLexicons(
      "com.example.getCursor",
      "com.example.getProfile",
      "com.example.getFeed",
      "com.example.event.getRecord",
      "com.example.event.listRecords",
      "com.example.event.featured",
      "com.example.profile.getRecord",
      "com.example.profile.listRecords",
      "com.example.follow.getRecord",
      "com.example.follow.listRecords",
    );
    const worker = createWorker(config, {
      lexicons,
      publicService: { endpoint: "https://api.example.com" },
    });
    const env = { DB: createSqliteDatabase(":memory:") };

    const profile = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.getProfile"),
      env,
    );
    expect(profile.status).toBe(400);
    const feed = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.getFeed"),
      env,
    );
    expect(feed.status).toBe(400);
    const custom = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.event.featured"),
      env,
    );
    expect(custom.status).toBe(200);
    expect(await custom.json()).toEqual({ records: [] });
    const manifest = await (
      await worker.fetch(
        new Request("https://api.example.com/.well-known/contrail"),
        env,
      )
    ).json<any>();
    expect(manifest.methods).toEqual(
      expect.arrayContaining([
        "com.example.getCursor",
        "com.example.getProfile",
        "com.example.getFeed",
        "com.example.event.featured",
      ]),
    );
    expect(manifest.methods).not.toContain("com.example.notifyOfUpdate");

    const notify = await worker.fetch(
      new Request("https://api.example.com/xrpc/com.example.notifyOfUpdate", {
        method: "POST",
        body: JSON.stringify({ uri: "at://did:plc:test/com.example.event/1" }),
      }),
      env,
    );
    expect(notify.status).toBe(401);
  });

  it("refuses public mode without an ordered source, HTTPS origin, and Lexicons", () => {
    expect(() =>
      createWorker(
        { ...MINIMAL_CONFIG, orderedSource: undefined },
        {
          lexicons: MINIMAL_PUBLIC_LEXICONS,
          publicService: { endpoint: "https://api.example.com" },
        },
      ),
    ).toThrow("requires orderedSource");

    expect(() =>
      createWorker(MINIMAL_CONFIG, {
        publicService: { endpoint: "https://api.example.com" },
      }),
    ).toThrow("non-empty Lexicon bundle");

    expect(() =>
      createWorker(MINIMAL_CONFIG, {
        lexicons: [{ lexicon: 1, id: "com.example.foo" }],
        publicService: { endpoint: "http://api.example.com" },
      }),
    ).toThrow("must use HTTPS");

    expect(() =>
      createWorker(MINIMAL_CONFIG, {
        lexicons: [
          {
            lexicon: 1,
            id: "com.example.event.listRecords",
            defs: { main: { type: "query" } },
          },
        ],
        publicService: { endpoint: "https://api.example.com" },
      }),
    ).toThrow("public method requires a matching query Lexicon");
  });

  it("scheduled handler runs live ingest then a bounded backfill retry slice", async () => {
    const order: string[] = [];
    const ingest = vi
      .spyOn(Contrail.prototype, "ingest")
      .mockImplementation(async () => {
        order.push("ingest");
      });
    const retry = vi
      .spyOn(Contrail.prototype, "retryBackfill")
      .mockImplementation(async () => {
        order.push("retry");
        return {
          attempted: 0,
          completed: 0,
          failed: 0,
          records: 0,
          skipped: false,
        };
      });

    try {
      const db = createSqliteDatabase(":memory:");
      const worker = createWorker(MINIMAL_CONFIG);
      const env = { DB: db };
      const waitUntil = vi.fn();
      const ctx = {
        waitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      await worker.scheduled({} as ScheduledEvent, env, ctx);

      expect(waitUntil).toHaveBeenCalledTimes(1);
      const scheduled = waitUntil.mock.calls[0][0];
      expect(scheduled).toBeInstanceOf(Promise);
      await scheduled;
      expect(order).toEqual(["ingest", "retry"]);
    } finally {
      ingest.mockRestore();
      retry.mockRestore();
    }
  });
});
