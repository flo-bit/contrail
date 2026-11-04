# Spaces prototype

A local, single-process private-event app: sign in, create an event, share a link, join with another account, and RSVP. No mock data is used by the app.

## Run locally

From the `spaces-invitations` worktree root, with Node 24 and pnpm 10:

```sh
pnpm install
pnpm --filter @atmo-dev/contrail build
pnpm --filter @atmo-dev/contrail-spaces-alpha build
pnpm --filter contrail-spaces-prototype dev
```

Open **http://127.0.0.1:5177**, not `localhost`. OAuth uses a loopback public client; no client keys, environment variables, deployment or public callback tunnel are needed. The app intentionally refuses other origins. Do not expose it to a network or run multiple processes.

You need **two real accounts on a PDS running the October 29, 2026 Spaces alpha**, compatible with the extension's pinned `0.0.0-spaces-alpha-20261029171913` snapshot. A normal production Bluesky account/PDS is not sufficient. Accounts need published KEM keys for authenticated Spaces synchronization. This app does not provision a PDS, accounts or keys. The browser and Node process must run on the same computer for loopback OAuth.

## Try it

1. Sign in as the host, enter a name and optionally a time/details, and click **Create private event**. This writes a real memberspace and calendar event to the host's PDS.
2. Click **Create invite link**, then **Copy link**. This writes an invitation verifier into a separate, owner-only personalspace on the host's PDS. The usable secret is returned only in the link fragment.
3. Open the link in a second browser profile/private window. Preview shows only the event's name, time and details; it does not join or disclose attendees.
4. Sign in with the second account, then click **Join event**. This explicitly grants that authenticated account native read/write membership through the host's restored OAuth grant.
5. On the event page, click **Going** or **Can’t go**. This is a separate, guest-owned calendar RSVP write. Refresh the host's event page to see it.
6. **Revoke link** prevents future joins through that link. It does not remove existing members or their RSVPs. Native member removal is not exposed by this prototype.

Host sign-out ends the browser session, but keeps the app's in-memory owner grant available for offline invitation acceptance. No tokens are sent to guests. Restarting the process removes that grant, so the host must sign in again before links can be previewed/redeemed.

## Deliberate limits

- OAuth grants, browser sessions, pending invitations, credential-encryption key, and the SQLite projection are **in memory**. Restarting loses local state, **not records, spaces or memberships already written to the PDS**. There is no automatic cleanup or rollback of remote writes, and a failed multi-step operation may leave a space behind.
- The home page discovers up to 20 event spaces from the signed-in account's PDS. A newly joined space appears there after that account writes its first RSVP; `listSpaces` is a writer/authority listing, not a membership directory. Known event URLs remain usable. The event page reads up to 100 RSVP records and recognizes one deterministic RSVP key per writer (the event's TID); records with other keys are ignored.
- Each authenticated read obtains a fresh delegation and waits for authenticated Contrail reconciliation. There is no push connection, notification registration, scheduler or background worker; refresh to see changes. Existing bounded STAR recovery is used unchanged.
- Invitation links are reusable bearer links without an expiry until revoked. Treat them as private. The browser strips the fragment after transferring the secret via POST into short-lived, opaque-cookie-backed server state (15 minutes), including across sign-in. Reopen the original link if that state expires. Link management only shows the link just created, not an invitation history.
- One OAuth client and its in-memory refresh lock coordinate host and guest requests. There is no distributed token storage/locking. State-changing endpoints require same-origin POSTs and have a process-wide limit of 60 requests/minute. Responses use `private, no-store` and `no-referrer`; no analytics, public AppView calls or external assets are included.
- Application NSIDs in `src/lib/config.ts` are test-only placeholders. Nothing publishes Lexicons. Use an application-owned namespace and publish the invitation Lexicon before making an interoperable/public application. Calendar event/RSVP schemas are copied unchanged from the benchmark's standard Lexicons and validated with the alpha Spaces validator.
- This is a local experiment, not production infrastructure. There is no event editor, profile lookup, member directory, public projection, deployment configuration or backward-compatibility layer.

## Check

```sh
pnpm --filter contrail-spaces-prototype typecheck
pnpm --filter contrail-spaces-prototype test
pnpm --filter contrail-spaces-prototype build
```

Browser smoke tests build and start a fresh local server; stop any existing prototype server first. Install Chromium once if necessary:

```sh
pnpm --filter contrail-spaces-prototype exec playwright install chromium
pnpm --filter contrail-spaces-prototype test:browser
```

Unit tests use a fake PDS and isolated route fixtures. Browser tests cover desktop/mobile sign-in, the real fragment-to-POST flow, and request security without OAuth grants. No tests sign in to real accounts, publish records, or change real memberships. A real two-account end-to-end test is still required against a compatible alpha PDS.
