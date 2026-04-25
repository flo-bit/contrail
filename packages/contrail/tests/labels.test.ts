import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { resolveConfig, type ContrailConfig } from "../src/core/types";
import { applyLabels } from "../src/core/labels/apply";
import { hydrateLabels } from "../src/core/labels/hydrate";
import { selectAcceptedLabelers } from "../src/core/labels/select";
import type { LabelsConfig } from "../src/core/labels/types";

const SRC_A = "did:plc:labelerA";
const SRC_B = "did:plc:labelerB";
const URI_X = "at://did:plc:author/com.example.event/1";
const URI_Y = "at://did:plc:author/com.example.event/2";
const ACC_DID = "did:plc:author";

function ctsIso(deltaSec = 0): string {
  return new Date(Date.now() + deltaSec * 1000).toISOString();
}

async function setup() {
  const db = createSqliteDatabase(":memory:");
  const config: ContrailConfig = {
    namespace: "com.example",
    collections: {
      event: { collection: "com.example.event" },
    },
    labels: {
      sources: [{ did: SRC_A }, { did: SRC_B }],
    },
  };
  const resolved = resolveConfig(config);
  await initSchema(db, resolved);
  return { db, config: resolved };
}

describe("labels: applyLabels + hydrate", () => {
  it("upserts and hydrates a basic label", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "spam", cts: ctsIso() },
    ]);
    const out = await hydrateLabels(db, [URI_X], [SRC_A]);
    expect(out[URI_X]).toHaveLength(1);
    expect(out[URI_X][0]!.val).toBe("spam");
    expect(out[URI_X][0]!.src).toBe(SRC_A);
  });

  it("filters by accepted labelers — unaccepted source drops out", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "a", cts: ctsIso() },
      { src: SRC_B, uri: URI_X, val: "b", cts: ctsIso() },
    ]);
    const out = await hydrateLabels(db, [URI_X], [SRC_A]);
    expect(out[URI_X]).toHaveLength(1);
    expect(out[URI_X][0]!.val).toBe("a");
  });

  it("collapses (src, uri, val) by latest cts and drops neg=true winners", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "spam", cts: ctsIso(-10) },
      // Negation arrives later — should retract.
      { src: SRC_A, uri: URI_X, val: "spam", cts: ctsIso(0), neg: true },
    ]);
    const out = await hydrateLabels(db, [URI_X], [SRC_A]);
    expect(out[URI_X] ?? []).toHaveLength(0);
  });

  it("re-positive after a negation wins again", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "spam", cts: ctsIso(-20) },
      { src: SRC_A, uri: URI_X, val: "spam", cts: ctsIso(-10), neg: true },
      { src: SRC_A, uri: URI_X, val: "spam", cts: ctsIso(0) },
    ]);
    const out = await hydrateLabels(db, [URI_X], [SRC_A]);
    expect(out[URI_X]).toHaveLength(1);
  });

  it("expired labels are dropped", async () => {
    const { db } = await setup();
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "x", cts: ctsIso(-3600), exp: yesterday },
    ]);
    const out = await hydrateLabels(db, [URI_X], [SRC_A]);
    expect(out[URI_X] ?? []).toHaveLength(0);
  });

  it("CID pin filters to matching record version", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "v1-only", cts: ctsIso(), cid: "bafy-old" },
      { src: SRC_A, uri: URI_X, val: "any-version", cts: ctsIso() },
    ]);
    const cidByUri = new Map([[URI_X, "bafy-new"]]);
    const out = await hydrateLabels(db, [URI_X], [SRC_A], cidByUri);
    expect(out[URI_X]?.map((l) => l.val).sort()).toEqual(["any-version"]);
  });

  it("account-level label keyed by bare DID hydrates fine", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: ACC_DID, val: "!hide", cts: ctsIso() },
    ]);
    const out = await hydrateLabels(db, [ACC_DID], [SRC_A]);
    expect(out[ACC_DID]).toHaveLength(1);
    expect(out[ACC_DID][0]!.val).toBe("!hide");
  });

  it("cross-subject hydration: many uris in one query", async () => {
    const { db } = await setup();
    await applyLabels(db, [
      { src: SRC_A, uri: URI_X, val: "a", cts: ctsIso() },
      { src: SRC_A, uri: URI_Y, val: "b", cts: ctsIso() },
    ]);
    const out = await hydrateLabels(db, [URI_X, URI_Y], [SRC_A]);
    expect(out[URI_X]).toHaveLength(1);
    expect(out[URI_Y]).toHaveLength(1);
  });
});

describe("labels: selectAcceptedLabelers", () => {
  const cfg: LabelsConfig = {
    sources: [{ did: SRC_A }, { did: SRC_B }],
  };

  it("falls back to defaults (= sources) when caller sends nothing", () => {
    const sel = selectAcceptedLabelers(null, null, cfg);
    expect(sel.accepted).toEqual([SRC_A, SRC_B]);
  });

  it("honors header before query param", () => {
    const sel = selectAcceptedLabelers(SRC_A, SRC_B, cfg);
    expect(sel.accepted).toEqual([SRC_A]);
  });

  it("falls through to query param when header is empty", () => {
    const sel = selectAcceptedLabelers("", SRC_B, cfg);
    expect(sel.accepted).toEqual([SRC_B]);
  });

  it("drops unknown DIDs", () => {
    const sel = selectAcceptedLabelers("did:plc:strangerlabeler", null, cfg);
    expect(sel.accepted).toEqual([]);
  });

  it("mixes known + unknown — keeps only the known", () => {
    const sel = selectAcceptedLabelers(
      `did:plc:strangerlabeler,${SRC_A}`,
      null,
      cfg,
    );
    expect(sel.accepted).toEqual([SRC_A]);
  });

  it("strips ;param modifiers from header values", () => {
    const sel = selectAcceptedLabelers(
      `${SRC_A};redact, ${SRC_B} ; foo`,
      null,
      cfg,
    );
    expect(sel.accepted).toEqual([SRC_A, SRC_B]);
  });

  it("caps at maxPerRequest", () => {
    const sel = selectAcceptedLabelers(
      `${SRC_A},${SRC_B}`,
      null,
      { ...cfg, maxPerRequest: 1 },
    );
    expect(sel.accepted).toEqual([SRC_A]);
  });

  it("empty defaults => no labelers when caller is silent (opt-in policy)", () => {
    const sel = selectAcceptedLabelers(null, null, { ...cfg, defaults: [] });
    expect(sel.accepted).toEqual([]);
  });

  it("dedupes repeated DIDs in caller list", () => {
    const sel = selectAcceptedLabelers(`${SRC_A},${SRC_A},${SRC_A}`, null, cfg);
    expect(sel.accepted).toEqual([SRC_A]);
  });
});
