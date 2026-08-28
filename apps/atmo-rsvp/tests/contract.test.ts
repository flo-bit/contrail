import { describe, expect, it } from "vitest";
import { describePublicService } from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { createWorker } from "@atmo-dev/contrail/worker";
import { lexicons } from "../lexicons/generated";
import { config, searchGenerationConfig } from "../src/contrail.config";
import {
  createAtmoMeilisearchRuntime,
  type AtmoMeilisearchEnv,
} from "../src/meilisearch";

const EXPECTED_METHODS = [
  "rsvp.atmo.event.getRecord",
  "rsvp.atmo.event.listRecords",
  "rsvp.atmo.getCursor",
  "rsvp.atmo.getProfile",
  "rsvp.atmo.rsvp.getRecord",
  "rsvp.atmo.rsvp.listRecords",
];

const EXPECTED_PROTECTED_METHODS = [
  { id: "rsvp.atmo.getFeed", type: "query" },
  { id: "rsvp.atmo.notifyOfUpdate", type: "procedure" },
];

describe("api.atmo.rsvp public contract", () => {
  it("keeps profile and follow projections internal and validation disabled", () => {
    expect(config.validation).toBeUndefined();
    expect(config.collections.profile?.methods).toEqual([]);
    expect(config.collections.follow).toMatchObject({
      discover: false,
      subjectField: "subject",
      methods: [],
    });
    expect(config.feeds?.network.targets).toEqual([
      { collection: "event", maxItems: 100 },
      { collection: "rsvp", maxItems: 250 },
    ]);
  });

  it("advertises the exact generated calendar API", async () => {
    const service = await describePublicService(
      config,
      { endpoint: "https://api.atmo.rsvp" },
      lexicons,
    );

    expect(service.manifest.namespace).toBe("rsvp.atmo");
    expect(service.manifest.methods).toEqual(EXPECTED_METHODS);
    expect(service.manifest.methods).not.toContain("rsvp.atmo.getOverview");
    expect(service.manifest.serviceAuth).toEqual({
      type: "atproto-service-auth",
      serviceDid: "did:web:api.atmo.rsvp",
      audience: "did:web:api.atmo.rsvp#contrail",
      scope:
        "rpc?aud=did:web:api.atmo.rsvp%23contrail&lxm=rsvp.atmo.getFeed&lxm=rsvp.atmo.notifyOfUpdate",
      methods: EXPECTED_PROTECTED_METHODS,
    });
    expect(service.lexicons.map((document) => document.id)).toEqual(
      expect.arrayContaining([
        "app.bsky.actor.profile",
        "app.bsky.graph.follow",
        "rsvp.atmo.getFeed",
        "rsvp.atmo.notifyOfUpdate",
      ]),
    );
    expect(service.manifest.version).toBe(2);
    expect(service.manifest).not.toHaveProperty("contract");
  });

  it("passes synchronous Worker startup validation", () => {
    expect(() =>
      createWorker(config, {
        lexicons,
        publicService: { endpoint: "https://api.atmo.rsvp" },
      }),
    ).not.toThrow();
    expect(searchGenerationConfig.changes?.consumers.search).toEqual({
      collections: ["community.lexicon.calendar.event"],
      phases: ["historical", "live"],
      initial: "current",
      requiredForActivation: true,
    });
    const search = createAtmoMeilisearchRuntime();
    expect(() =>
      createWorker<AtmoMeilisearchEnv & Record<string, unknown>>(
        searchGenerationConfig,
        {
          lexicons,
          publicService: { endpoint: "https://api.atmo.rsvp" },
          ...search,
        },
      ),
    ).not.toThrow();
  });

  it("publishes its service DID and permits browser auth headers", async () => {
    const worker = createWorker(config, {
      lexicons,
      publicService: { endpoint: "https://api.atmo.rsvp" },
    });
    const env = { DB: createSqliteDatabase(":memory:") };
    const did = await worker.fetch(
      new Request("https://api.atmo.rsvp/.well-known/did.json"),
      env,
    );
    expect(did.status).toBe(200);
    expect(await did.json()).toMatchObject({
      id: "did:web:api.atmo.rsvp",
      service: [
        {
          id: "did:web:api.atmo.rsvp#contrail",
          serviceEndpoint: "https://api.atmo.rsvp",
        },
      ],
    });

    const preflight = await worker.fetch(
      new Request("https://api.atmo.rsvp/xrpc/rsvp.atmo.getFeed", {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });
});
