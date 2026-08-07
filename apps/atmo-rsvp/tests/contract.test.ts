import { describe, expect, it } from "vitest";
import {
  contractFromManifest,
  describePublicService,
  digestPublicContract,
} from "@atmo-dev/contrail";
import { createWorker } from "@atmo-dev/contrail/worker";
import { lexicons } from "../lexicons/generated";
import { config } from "../src/contrail.config";

const EXPECTED_METHODS = [
  "rsvp.atmo.event.getRecord",
  "rsvp.atmo.event.listRecords",
  "rsvp.atmo.getCursor",
  "rsvp.atmo.rsvp.getRecord",
  "rsvp.atmo.rsvp.listRecords",
];

describe("api.atmo.rsvp public contract", () => {
  it("advertises the exact generated calendar API", async () => {
    const service = await describePublicService(
      config,
      { endpoint: "https://api.atmo.rsvp" },
      lexicons,
    );

    expect(service.manifest.namespace).toBe("rsvp.atmo");
    expect(service.manifest.methods).toEqual(EXPECTED_METHODS);
    expect(service.manifest.methods).not.toContain("rsvp.atmo.getOverview");
    expect(service.manifest.methods).not.toContain("rsvp.atmo.notifyOfUpdate");
    expect(service.lexicons.map((document) => document.id)).not.toContain(
      "com.atproto.label.defs",
    );
    expect(
      await digestPublicContract(contractFromManifest(service.manifest)),
    ).toBe(service.manifest.contract.digest);
    expect(service.manifest.contract.digest).not.toBe(
      service.manifest.lexicons.digest,
    );
  });

  it("passes synchronous Worker startup validation", () => {
    expect(() =>
      createWorker(config, {
        lexicons,
        publicService: { endpoint: "https://api.atmo.rsvp" },
      }),
    ).not.toThrow();
  });
});
