import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeRecord } from "@atproto/space";
import {
  bindRecordValidationProvider,
  createIngestEvent,
  resolveConfig,
  validateCanonicalRecord,
} from "@atmo-dev/contrail";
import { createSpaceRecordValidation } from "../src/validation";

const rsvp = JSON.parse(
  await readFile(
    new URL("./fixtures/calendar-rsvp.json", import.meta.url),
    "utf8",
  ),
);
const strongRef = JSON.parse(
  await readFile(
    new URL("./fixtures/strong-ref.json", import.meta.url),
    "utf8",
  ),
);
const collection = "community.lexicon.calendar.rsvp";
const rkey = "3h4oqw2vvxpwz";
const space = "at://did:plc:alice/space/rsvp.atmo.privateEvent/dinner";
const eventUri = `${space}/did:plc:alice/community.lexicon.calendar.event/${rkey}`;

describe("private calendar Lexicon validation", () => {
  it("validates the real calendar RSVP Lexicon with a Space strongRef and retains CID checks", async () => {
    const config = resolveConfig({
      namespace: "rsvp.atmo.private",
      collections: { rsvp: { collection, validate: true } },
    });
    const validation = createSpaceRecordValidation(
      [rsvp, strongRef],
      [collection],
    );
    await validation.ready;
    bindRecordValidationProvider(config, validation.validate);
    const record = {
      $type: collection,
      status: "community.lexicon.calendar.rsvp#going",
      subject: {
        uri: eventUri,
        cid: "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      },
    };
    const serialized = await serializeRecord(collection, rkey, record);
    const event = createIngestEvent({
      uri: `${space}/did:plc:bob/${collection}/${rkey}`,
      did: "did:plc:bob",
      collection,
      rkey,
      operation: "create",
      cid: serialized.cid.toString(),
      value: record,
      timeUs: 1,
      source: { id: "space", revision: "1", time_us: 1 },
    });
    expect(await validateCanonicalRecord(config, event, record)).toBeNull();
    expect(
      await validateCanonicalRecord(
        config,
        { ...event, cid: "invalid" },
        record,
      ),
    ).toBe("cid_mismatch");
    expect(
      await validateCanonicalRecord(config, event, {
        ...record,
        subject: { ...record.subject, uri: "https://not-an-at-uri" },
      }),
    ).toBe("lexicon_validation");
  });
  it("fails setup on missing referenced documents rather than relaxing strongRef", async () => {
    await expect(
      createSpaceRecordValidation([rsvp], [collection]).ready,
    ).rejects.toThrow();
  });
});
