/**
 * Publish locally-generated lexicons to a PDS as `com.atproto.lexicon.schema`
 * records. Each lexicon ends up at `at://<did>/com.atproto.lexicon.schema/<nsid>`.
 *
 * Exposed as a library function so downstream deployments can wrap it with a
 * one-line script pointing at their own `lexicons-generated/` directory.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface Session {
  did: string;
  accessJwt: string;
  pdsEndpoint: string;
}

async function login(identifier: string, password: string): Promise<Session> {
  const resolveRes = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`
  );
  let did: string;
  if (resolveRes.ok) {
    did = ((await resolveRes.json()) as { did: string }).did;
  } else if (identifier.startsWith("did:")) {
    did = identifier;
  } else {
    throw new Error(`Could not resolve handle: ${identifier}`);
  }

  const docUrl = did.startsWith("did:plc:")
    ? `https://plc.directory/${did}`
    : did.startsWith("did:web:")
      ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
      : null;
  if (!docUrl) throw new Error(`Unsupported DID method: ${did}`);

  const docRes = await fetch(docUrl);
  if (!docRes.ok) throw new Error(`Could not fetch DID doc for ${did}`);
  const doc = (await docRes.json()) as {
    service?: { id: string; type: string; serviceEndpoint: string }[];
  };
  const pds = doc.service?.find(
    (s) => s.id.endsWith("#atproto_pds") || s.type === "AtprotoPersonalDataServer"
  )?.serviceEndpoint;
  if (!pds) throw new Error(`No PDS service entry in DID doc for ${did}`);

  const sessionRes = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!sessionRes.ok) {
    throw new Error(`Login failed: ${sessionRes.status} ${await sessionRes.text()}`);
  }
  const session = (await sessionRes.json()) as { did: string; accessJwt: string };
  return { did: session.did, accessJwt: session.accessJwt, pdsEndpoint: pds };
}

function* walkJson(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkJson(full);
    else if (name.endsWith(".json")) yield full;
  }
}

async function putLexiconRecord(
  session: Session,
  lexicon: { id: string; [k: string]: unknown }
): Promise<void> {
  const body = {
    repo: session.did,
    collection: "com.atproto.lexicon.schema",
    rkey: lexicon.id,
    record: { $type: "com.atproto.lexicon.schema", ...lexicon },
  };
  const res = await fetch(`${session.pdsEndpoint}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`putRecord failed for ${lexicon.id}: ${res.status} ${await res.text()}`);
  }
}

/** DNS authority an NSID resolves to: all segments except the final (name),
 *  read right-to-left. Example: `rsvp.atmo.space.deleteRecord` → `space.atmo.rsvp`
 *  (client looks up TXT at `_lexicon.space.atmo.rsvp`). Resolution does not walk
 *  up — each distinct authority needs its own TXT record. */
export function nsidAuthority(nsid: string): string {
  const parts = nsid.split(".");
  if (parts.length < 2) return nsid;
  return parts.slice(0, -1).reverse().join(".");
}

/** Root DNS zone for an NSID — the first two segments reversed. */
export function nsidRootDomain(nsid: string): string {
  const parts = nsid.split(".");
  if (parts.length < 2) return nsid;
  return `${parts[1]}.${parts[0]}`;
}

export interface PublishOptions {
  /** Directory to walk for `*.json` lexicon files. */
  generatedDir: string;
  /** PDS account handle or DID. */
  identifier: string;
  /** App password (or equivalent on a non-bsky PDS). */
  password: string;
  /** Skip the interactive "do you control these zones?" prompt. */
  skipConfirm?: boolean;
}

export async function publishLexicons(opts: PublishOptions): Promise<{
  published: number;
  failed: string[];
  authorities: string[];
  session: Session;
}> {
  const lexicons: { id: string; [k: string]: unknown }[] = [];
  for (const file of walkJson(opts.generatedDir)) {
    const doc = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof doc.id === "string") lexicons.push(doc);
  }
  lexicons.sort((a, b) => a.id.localeCompare(b.id));

  const rootDomains = new Set<string>();
  const authorities = new Set<string>();
  for (const lex of lexicons) {
    rootDomains.add(nsidRootDomain(lex.id));
    authorities.add(nsidAuthority(lex.id));
  }
  const sortedAuthorities = [...authorities].sort();

  console.log(`About to publish ${lexicons.length} lexicons from ${opts.generatedDir}.\n`);
  console.log(
    `⚠  Do you control ${rootDomains.size === 1 ? "the DNS zone" : "these DNS zones"} below?`
  );
  for (const root of [...rootDomains].sort()) console.log(`     ${root}`);
  console.log(
    "\n   You'll need to add TXT records under that zone so clients can\n" +
      "   resolve the NSIDs. If you don't control it, the records will\n" +
      "   sit on your PDS but won't be authoritative.\n\n" +
      "   ⚠  Specifically: permission sets (OAuth `include:` scopes) will\n" +
      "   not work without DNS resolution — the user's PDS fetches the\n" +
      "   permission-set lexicon by resolving the NSID, and resolution\n" +
      "   requires a valid TXT record.\n"
  );

  if (!opts.skipConfirm) {
    const rl = createInterface({ input, output });
    const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return { published: 0, failed: [], authorities: sortedAuthorities, session: null as never };
    }
  }

  console.log(`\nLogging in as ${opts.identifier}…`);
  const session = await login(opts.identifier, opts.password);
  console.log(`  DID: ${session.did}`);
  console.log(`  PDS: ${session.pdsEndpoint}\n`);
  console.log(`Publishing ${lexicons.length} lexicons…\n`);

  let ok = 0;
  const failed: string[] = [];
  for (const lex of lexicons) {
    try {
      await putLexiconRecord(session, lex);
      console.log(`  ✓ ${lex.id}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${lex.id}: ${(err as Error).message}`);
      failed.push(lex.id);
    }
  }

  console.log(
    `\nPublished ${ok}/${lexicons.length} lexicons${failed.length > 0 ? ` (failures: ${failed.join(", ")})` : ""}.`
  );

  console.log("\n─────────────────────────────────────────────────");
  console.log("DNS TXT records needed for NSID resolution");
  console.log("─────────────────────────────────────────────────");
  console.log(
    "Atproto NSID resolution does NOT walk up — each distinct authority\n" +
      "needs its own TXT record. One record per unique authority below.\n"
  );
  for (const authority of sortedAuthorities) {
    console.log(`  host:  _lexicon.${authority}`);
    console.log(`  value: did=${session.did}`);
    console.log("");
  }
  console.log(`Total: ${sortedAuthorities.length} DNS TXT record(s) to add.`);

  return { published: ok, failed, authorities: sortedAuthorities, session };
}
