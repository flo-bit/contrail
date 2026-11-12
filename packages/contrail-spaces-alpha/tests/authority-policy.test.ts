import { resolveConfig } from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { describe, expect, it } from "vitest";
import { isAuthorityDecidedPolicy, isSyncedSpacePolicy } from "../src/policy";
import {
  ensureSpaceWatch,
  getSpaceWatch,
  initSpacesStorage,
} from "../src/storage";
import { SpacesSyncEngine } from "../src/sync";
import { createSpacesWorker } from "../src/worker";

const authority = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const audience = "did:web:rooms.example#spaces";
const collection = "example.group.note";
const space = `at://${authority}/space/example.group.board/self`;

const projection = () =>
  resolveConfig({
    namespace: "example.group",
    profiles: [],
    collections: { note: { collection, validate: true } },
    validation: { verifyCid: false },
  });

const lexicons = [
  {
    lexicon: 1,
    id: collection,
    defs: {
      main: {
        type: "record",
        key: "tid",
        record: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", maxLength: 2000 } },
        },
      },
    },
  },
] as const;

const options = (policy: unknown) => ({
  projection: projection(),
  lexicons,
  service: { endpoint: "https://rooms.example", audience },
  spaceTypes: {
    "example.group.board": { collections: [collection], policy: policy as never },
  },
});

describe("authority-decided Space types", () => {
  it("recognizes only the exact configuration marker", () => {
    expect(isAuthorityDecidedPolicy({ $type: "authority" })).toBe(true);
    expect(isAuthorityDecidedPolicy({ $type: "authority", extra: 1 })).toBe(false);
    expect(isAuthorityDecidedPolicy(undefined)).toBe(false);
    // It is never a wire policy.
    expect(isSyncedSpacePolicy({ $type: "authority" })).toBe(false);
  });

  it("needs no authorizer and still rejects another service's managed policy", () => {
    expect(() => createSpacesWorker(options({ $type: "authority" }))).not.toThrow();
    expect(() =>
      createSpacesWorker(
        options({
          $type: "com.atproto.managedspace.policy",
          managingApp: "did:web:host.example#group_host",
        }),
      ),
    ).toThrow("must be managed by this service");
  });

  it("validates a watch without reading a published policy", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = projection();
    await initSpacesStorage(db, config);
    await ensureSpaceWatch(db, { spaceUri: space });
    const watch = (await getSpaceWatch(db, space))!;
    const engine = new SpacesSyncEngine(db, {
      projection: config,
      spaceTypes: {
        "example.group.board": {
          collections: [collection],
          policy: { $type: "authority" },
        },
      },
      serviceAudience: audience,
      credentialEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    } as never);
    // Any transport use would throw: none is supplied or loadable.
    await expect(
      engine.validateWatch(watch, {
        get: () => {
          throw new Error("no network read expected");
        },
      } as never),
    ).resolves.toBeUndefined();
  });
});
