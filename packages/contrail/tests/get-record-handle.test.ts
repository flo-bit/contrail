/** getRecord resolves a handle in the URI authority (like the actor-param
 *  endpoints) via resolveActor — local-first, network only on a miss. DID URIs
 *  are unaffected (resolveActor returns a DID unchanged). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Contrail } from "../src/contrail";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { ingestRecords } from "../src/index";
import { __resetPdsCachesForTests } from "../src/index";
import type { Database, IngestEvent } from "../src/index";

const COLL = "com.example.event";
const AUTHOR = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const HANDLE = "alice.example.com";
const RKEY = "rec1";
const URI = `at://${AUTHOR}/${COLL}/${RKEY}`;

function ev(): IngestEvent {
  const now = Date.now() * 1000;
  return {
    uri: URI,
    did: AUTHOR,
    collection: COLL,
    rkey: RKEY,
    operation: "create",
    cid: "bafy-1",
    record: JSON.stringify({ name: "Test Event" }),
    time_us: now,
    indexed_at: now,
  };
}

async function setup() {
  const db = createSqliteDatabase(":memory:");
  const contrail = new Contrail({
    namespace: "ex",
    collections: { event: { collection: COLL } },
    db,
  });
  await contrail.init();
  await ingestRecords(db, [ev()], contrail.config);
  return { db, contrail };
}

async function seedIdentity(db: Database, did: string, handle: string) {
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)"
    )
    .bind(did, handle, null, Date.now())
    .run();
}

function getRecord(contrail: Contrail, uri: string) {
  return contrail
    .app()
    .fetch(
      new Request(
        `http://localhost/xrpc/ex.event.getRecord?uri=${encodeURIComponent(uri)}`
      )
    );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetPdsCachesForTests();
  fetchSpy = vi.spyOn(global, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
  __resetPdsCachesForTests();
});

describe("getRecord authority resolution", () => {
  it("returns the record for a DID URI (unchanged behavior, no network)", async () => {
    const { contrail } = await setup();
    const res = await getRecord(contrail, URI);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string };
    expect(body.uri).toBe(URI);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves a handle URI from identities (no network) and returns the canonical record", async () => {
    const { db, contrail } = await setup();
    await seedIdentity(db, AUTHOR, HANDLE);

    const res = await getRecord(contrail, `at://${HANDLE}/${COLL}/${RKEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; did: string };
    expect(body.uri).toBe(URI); // canonicalized to the DID URI
    expect(body.did).toBe(AUTHOR);
    expect(fetchSpy).not.toHaveBeenCalled(); // served from identities
  });

  it("400s on a malformed URI", async () => {
    const { contrail } = await setup();
    const res = await getRecord(contrail, "not-an-at-uri");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("400s on a non-record URI (repo only, no collection/rkey)", async () => {
    const { contrail } = await setup();
    const res = await getRecord(contrail, `at://${AUTHOR}`);
    expect(res.status).toBe(400);
  });

  it("404s when the actor resolves but the record doesn't exist", async () => {
    const { contrail } = await setup();
    const res = await getRecord(contrail, `at://${AUTHOR}/${COLL}/missing`);
    expect(res.status).toBe(404);
  });

  it("400s when a handle can't be resolved (local miss + network failure)", async () => {
    const { contrail } = await setup();
    // No identities row for this handle; slingshot returns non-ok.
    fetchSpy.mockResolvedValue(new Response("", { status: 404 }));

    const res = await getRecord(contrail, `at://bob.example.com/${COLL}/${RKEY}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Could not resolve actor");
  });
});
