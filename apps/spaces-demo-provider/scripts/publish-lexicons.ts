import { createHash } from "node:crypto";
import { networkLexicons } from "../src/lexicons";

const collection = "com.atproto.lexicon.schema";
const retiredLexicons = ["garden.atmo.circle.member"] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function jsonRequest(
  url: string | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const pds = required("LEXICON_AUTHORITY_PDS").replace(/\/$/, "");
const identifier = required("LEXICON_AUTHORITY_IDENTIFIER");
const password = required("LEXICON_AUTHORITY_PASSWORD");
const expectedDid = process.env.LEXICON_AUTHORITY_DID;

const session = await jsonRequest(`${pds}/xrpc/com.atproto.server.createSession`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier, password }),
});
const accessJwt = String(session.accessJwt ?? "");
const did = String(session.did ?? "");
if (!accessJwt || !did.startsWith("did:")) throw new Error("Authority login returned no session");
if (expectedDid && did !== expectedDid) {
  throw new Error(`Authority DID mismatch: expected ${expectedDid}, received ${did}`);
}

for (const doc of networkLexicons) {
  const existing = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
  existing.searchParams.set("repo", did);
  existing.searchParams.set("collection", collection);
  existing.searchParams.set("rkey", doc.id);
  const current = await fetch(existing, {
    headers: { authorization: `Bearer ${accessJwt}` },
  });
  if (current.ok) {
    const body = await current.json() as { value?: unknown };
    if (digest(body.value) === digest(doc)) {
      console.log(`lexicon unchanged: ${doc.id}`);
      continue;
    }
  } else if (current.status !== 400 && current.status !== 404) {
    throw new Error(`${existing} failed (${current.status}): ${await current.text()}`);
  }

  await jsonRequest(`${pds}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repo: did,
      collection,
      rkey: doc.id,
      record: doc,
    }),
  });
  console.log(`published lexicon: ${doc.id}`);
}

for (const nsid of retiredLexicons) {
  const existing = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
  existing.searchParams.set("repo", did);
  existing.searchParams.set("collection", collection);
  existing.searchParams.set("rkey", nsid);
  const current = await fetch(existing, {
    headers: { authorization: `Bearer ${accessJwt}` },
  });
  if (current.status === 400 || current.status === 404) continue;
  if (!current.ok) {
    throw new Error(`${existing} failed (${current.status}): ${await current.text()}`);
  }
  await jsonRequest(`${pds}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repo: did, collection, rkey: nsid }),
  });
  console.log(`retired lexicon: ${nsid}`);
}

console.log(`published ${networkLexicons.length} network Lexicons from ${did}`);
