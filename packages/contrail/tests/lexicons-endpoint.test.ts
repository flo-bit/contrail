import { describe, it, expect } from "vitest";
import { createApp } from "../src/core/router";
import { createTestDbWithSchema, TEST_CONFIG } from "./helpers";

describe("/xrpc/<ns>.lexicons endpoint", () => {
  it("returns the bundled lexicons when passed", async () => {
    const db = await createTestDbWithSchema();
    const lexicons = [
      { lexicon: 1, id: "com.example.event.listRecords", defs: { main: { type: "query" } } },
      { lexicon: 1, id: "com.example.event.getRecord", defs: { main: { type: "query" } } },
    ];
    const app = createApp(db, TEST_CONFIG, { lexicons });

    const res = await app.fetch(new Request("http://localhost/xrpc/com.example.lexicons"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ lexicons });
  });

  it("404s when no lexicons were passed (route not registered)", async () => {
    const db = await createTestDbWithSchema();
    const app = createApp(db, TEST_CONFIG); // no lexicons

    const res = await app.fetch(new Request("http://localhost/xrpc/com.example.lexicons"));
    expect(res.status).toBe(404);
  });

  it("404s when lexicons array is empty (treated as not-passed)", async () => {
    const db = await createTestDbWithSchema();
    const app = createApp(db, TEST_CONFIG, { lexicons: [] });

    const res = await app.fetch(new Request("http://localhost/xrpc/com.example.lexicons"));
    expect(res.status).toBe(404);
  });

  it("uses the config's namespace in the path", async () => {
    const db = await createTestDbWithSchema();
    const lexicons = [{ lexicon: 1, id: "x" }];
    const app = createApp(db, TEST_CONFIG, { lexicons });

    // Wrong namespace → 404
    const wrong = await app.fetch(new Request("http://localhost/xrpc/wrong.ns.lexicons"));
    expect(wrong.status).toBe(404);

    // Right namespace → 200
    const right = await app.fetch(new Request("http://localhost/xrpc/com.example.lexicons"));
    expect(right.status).toBe(200);
  });
});
