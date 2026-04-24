import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import { MemoryBlobAdapter } from "../src/core/spaces/blob-adapter";
import { HostedAdapter } from "../src/core/spaces/adapter";
import { gcOrphanBlobs } from "../src/core/spaces/blob-gc";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";

function makeConfig(blobs: MemoryBlobAdapter, maxSize = 2 * 1024 * 1024): ContrailConfig {
  return {
    namespace: "test.blobs",
    collections: {
      photo: { collection: "app.event.photo" },
    },
    spaces: {
      type: "tools.atmo.event.space",
      serviceDid: "did:web:test.example#svc",
      blobs: { adapter: blobs, maxSize },
    },
  };
}

function fakeAuth(aud: string): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", {
      issuer: did,
      audience: aud,
      lxm: undefined,
      clientId: c.req.header("X-Test-App") ?? undefined,
    });
    await next();
  };
}

async function makeApp(
  blobs: MemoryBlobAdapter,
  maxSize = 2 * 1024 * 1024
): Promise<{ app: Hono; db: any; config: ReturnType<typeof resolveConfig> }> {
  const db = createSqliteDatabase(":memory:");
  const cfg = makeConfig(blobs, maxSize);
  const resolved = resolveConfig(cfg);
  await initSchema(db, resolved);
  const app = createApp(db, resolved, {
    spaces: { authMiddleware: fakeAuth(cfg.spaces!.serviceDid) },
  });
  return { app, db, config: resolved };
}

function call(
  app: Hono,
  method: string,
  path: string,
  did: string,
  body?: BodyInit,
  contentType?: string
): Promise<Response> {
  const headers: Record<string, string> = { "X-Test-Did": did };
  if (contentType) headers["Content-Type"] = contentType;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body,
    })
  );
}

async function callJson(
  app: Hono,
  method: string,
  path: string,
  did: string,
  body?: any
): Promise<Response> {
  return call(
    app,
    method,
    path,
    did,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? undefined : "application/json"
  );
}

async function createSpace(app: Hono, owner: string, key: string): Promise<string> {
  const res = await callJson(app, "POST", "/xrpc/test.blobs.space.createSpace", owner, { key });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return body.space.uri;
}

describe("spaces blobs", () => {
  let app: Hono;
  let blobs: MemoryBlobAdapter;
  let spaceUri: string;

  beforeAll(async () => {
    blobs = new MemoryBlobAdapter();
    const out = await makeApp(blobs);
    app = out.app;
    spaceUri = await createSpace(app, ALICE, "album");
  });

  it("owner uploads a blob and gets back a valid BlobRef", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const res = await call(
      app,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(spaceUri)}`,
      ALICE,
      bytes,
      "image/png"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.blob.$type).toBe("blob");
    expect(body.blob.mimeType).toBe("image/png");
    expect(body.blob.size).toBe(bytes.byteLength);
    expect(typeof body.blob.ref.$link).toBe("string");
    expect(body.blob.ref.$link.startsWith("b")).toBe(true);
  });

  it("non-member cannot upload", async () => {
    const bytes = new TextEncoder().encode("intruder");
    const res = await call(
      app,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(spaceUri)}`,
      BOB,
      bytes,
      "image/png"
    );
    expect(res.status).toBe(403);
  });

  it("upload is rejected when bytes exceed maxSize", async () => {
    const tiny = new MemoryBlobAdapter();
    const { app: smallApp } = await makeApp(tiny, 64);
    const uri = await createSpace(smallApp, ALICE, "small");
    const bytes = new Uint8Array(128);
    const res = await call(
      smallApp,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(uri)}`,
      ALICE,
      bytes,
      "application/octet-stream"
    );
    expect(res.status).toBe(413);
  });

  it("getBlob returns bytes for a member, 403 for non-member, 404 for bogus cid", async () => {
    const payload = new TextEncoder().encode("download me");
    const up = await call(
      app,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(spaceUri)}`,
      ALICE,
      payload,
      "text/plain"
    );
    const { blob } = (await up.json()) as any;
    const cid = blob.ref.$link;

    // Member (owner) — gets bytes back.
    const okRes = await call(
      app,
      "GET",
      `/xrpc/test.blobs.space.getBlob?spaceUri=${encodeURIComponent(spaceUri)}&cid=${cid}`,
      ALICE
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("content-type")).toBe("text/plain");
    const got = new Uint8Array(await okRes.arrayBuffer());
    expect(new TextDecoder().decode(got)).toBe("download me");

    // Non-member — 403.
    const deny = await call(
      app,
      "GET",
      `/xrpc/test.blobs.space.getBlob?spaceUri=${encodeURIComponent(spaceUri)}&cid=${cid}`,
      CHARLIE
    );
    expect(deny.status).toBe(403);

    // Made-up CID — 404 even for the owner (never enumerate).
    const miss = await call(
      app,
      "GET",
      `/xrpc/test.blobs.space.getBlob?spaceUri=${encodeURIComponent(spaceUri)}&cid=bafynotareal`,
      ALICE
    );
    expect(miss.status).toBe(404);
  });

  it("putRecord rejects records referencing blobs that were not uploaded here", async () => {
    const res = await callJson(app, "POST", "/xrpc/test.blobs.space.putRecord", ALICE, {
      spaceUri,
      collection: "app.event.photo",
      record: {
        caption: "bogus",
        image: {
          $type: "blob",
          ref: { $link: "bafynotareal" },
          mimeType: "image/png",
          size: 10,
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.reason).toBe("unknown-blob-ref");
  });

  it("putRecord accepts records referencing a previously uploaded blob", async () => {
    const bytes = new TextEncoder().encode("real image bytes");
    const up = await call(
      app,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(spaceUri)}`,
      ALICE,
      bytes,
      "image/png"
    );
    const { blob } = (await up.json()) as any;

    const res = await callJson(app, "POST", "/xrpc/test.blobs.space.putRecord", ALICE, {
      spaceUri,
      collection: "app.event.photo",
      record: { caption: "ok", image: blob },
    });
    expect(res.status).toBe(200);
  });

  it("listBlobs returns metadata for members", async () => {
    const res = await call(
      app,
      "GET",
      `/xrpc/test.blobs.space.listBlobs?spaceUri=${encodeURIComponent(spaceUri)}`,
      ALICE
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.blobs)).toBe(true);
    expect(body.blobs.length).toBeGreaterThan(0);
    const row = body.blobs[0];
    expect(row).toHaveProperty("cid");
    expect(row).toHaveProperty("mimeType");
    expect(row).toHaveProperty("size");
    expect(row).toHaveProperty("authorDid");
  });

  it("gcOrphanBlobs deletes unreferenced blobs older than cutoff but keeps referenced ones", async () => {
    const isolatedBlobs = new MemoryBlobAdapter();
    const { app: isoApp, db } = await makeApp(isolatedBlobs);
    const uri = await createSpace(isoApp, ALICE, "gc-test");
    const storage = new HostedAdapter(db, makeConfig(isolatedBlobs));

    // Upload two blobs; reference only one of them.
    const keepBytes = new TextEncoder().encode("keep me");
    const dropBytes = new TextEncoder().encode("drop me");

    const keepUp = await call(
      isoApp,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(uri)}`,
      ALICE,
      keepBytes,
      "image/png"
    );
    const dropUp = await call(
      isoApp,
      "POST",
      `/xrpc/test.blobs.space.uploadBlob?spaceUri=${encodeURIComponent(uri)}`,
      ALICE,
      dropBytes,
      "image/png"
    );
    const keep = (await keepUp.json()) as any;
    const drop = (await dropUp.json()) as any;

    // Reference the "keep" blob from a record.
    const put = await callJson(isoApp, "POST", "/xrpc/test.blobs.space.putRecord", ALICE, {
      spaceUri: uri,
      collection: "app.event.photo",
      record: { caption: "keep", image: keep.blob },
    });
    expect(put.status).toBe(200);

    // Run GC with a cutoff far in the future so every blob is eligible by age.
    const result = await gcOrphanBlobs(storage, isolatedBlobs, uri, {
      olderThan: Date.now() + 60_000,
    });

    expect(result.deleted).toBe(1);
    expect(result.cids).toContain(drop.blob.ref.$link);
    expect(result.cids).not.toContain(keep.blob.ref.$link);

    // The "keep" blob is still retrievable; the dropped one is gone.
    const okRes = await call(
      isoApp,
      "GET",
      `/xrpc/test.blobs.space.getBlob?spaceUri=${encodeURIComponent(uri)}&cid=${keep.blob.ref.$link}`,
      ALICE
    );
    expect(okRes.status).toBe(200);
    const missRes = await call(
      isoApp,
      "GET",
      `/xrpc/test.blobs.space.getBlob?spaceUri=${encodeURIComponent(uri)}&cid=${drop.blob.ref.$link}`,
      ALICE
    );
    expect(missRes.status).toBe(404);
  });
});
