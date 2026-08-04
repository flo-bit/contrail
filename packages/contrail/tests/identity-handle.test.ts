import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPDS } from "../src/index";
import { __resetPdsCachesForTests } from "../src/core/client";
import { refreshStaleIdentities } from "../src/index";
import { createTestDbWithSchema } from "./helpers";
import type { Database } from "../src/index";
import type { Did } from "@atcute/lexicons";

// Root-cause coverage for PR #42: identities that end up with a PDS but no
// handle must not be stranded, and a partial re-resolution must never clobber a
// handle that was already known.

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as Did;
const PDS = "https://pds.example.host.bsky.network";

let db: Database;
let fetchSpy: ReturnType<typeof vi.spyOn>;

async function seedIdentity(
  did: string,
  handle: string | null,
  pds: string | null,
  resolvedAt: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)"
    )
    .bind(did, handle, pds, resolvedAt)
    .run();
}

async function readIdentity(
  did: string
): Promise<{ handle: string | null; pds: string | null; resolved_at: number } | null> {
  return db
    .prepare("SELECT handle, pds, resolved_at FROM identities WHERE did = ?")
    .bind(did)
    .first();
}

function slingshotReturns(body: { did?: string; handle?: string; pds?: string }) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(async () => {
  db = await createTestDbWithSchema();
  __resetPdsCachesForTests();
  fetchSpy = vi.spyOn(global, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  __resetPdsCachesForTests();
});

describe("getPDS heals a PDS-but-no-handle row", () => {
  it("re-resolves and backfills the missing handle", async () => {
    // A partial resolution persisted earlier: PDS known, handle null.
    await seedIdentity(DID, null, PDS, Date.now());
    // Slingshot now returns the handle.
    slingshotReturns({ did: DID, handle: "alice.test", pds: PDS });

    const pds = await getPDS(DID, db);

    expect(pds).toBe(PDS);
    expect(fetchSpy).toHaveBeenCalled(); // it did re-resolve, not strand
    expect((await readIdentity(DID))?.handle).toBe("alice.test");
  });

  it("still serves the known PDS if the heal resolution fails", async () => {
    await seedIdentity(DID, null, PDS, Date.now());
    fetchSpy.mockRejectedValue(new Error("slingshot down"));

    const pds = await getPDS(DID, db);

    expect(pds).toBe(PDS); // known PDS still returned
    expect((await readIdentity(DID))?.handle).toBeNull();
  });

  it("does NOT re-resolve a complete row (PDS + handle)", async () => {
    await seedIdentity(DID, "bob.test", PDS, Date.now());

    const pds = await getPDS(DID, db);

    expect(pds).toBe(PDS);
    expect(fetchSpy).not.toHaveBeenCalled(); // short-circuit preserved
    expect((await readIdentity(DID))?.handle).toBe("bob.test");
  });
});

describe("refreshStaleIdentities does not clobber a known handle", () => {
  it("keeps the existing handle when slingshot omits one", async () => {
    // Stale row with a good handle.
    await seedIdentity(DID, "carol.test", PDS, 0);
    // Partial response: PDS but no handle.
    slingshotReturns({ did: DID, pds: PDS });

    await refreshStaleIdentities(db, [DID]);

    const row = await readIdentity(DID);
    expect(row?.handle).toBe("carol.test"); // preserved, not nulled
    expect(row?.pds).toBe(PDS);
    expect(row?.resolved_at).toBeGreaterThan(0); // refresh did run
  });

  it("still applies a changed handle (non-null overwrites)", async () => {
    await seedIdentity(DID, "carol.test", PDS, 0);
    slingshotReturns({ did: DID, handle: "carol.new", pds: PDS });

    await refreshStaleIdentities(db, [DID]);

    expect((await readIdentity(DID))?.handle).toBe("carol.new");
  });
});
