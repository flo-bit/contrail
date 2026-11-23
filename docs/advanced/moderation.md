# Moderation and account lifecycle

Contrail enforces hides/takedowns and account lifecycle in SQL, independent of `Atproto-Accept-Labelers`. Moderator actions are public repository records; user reports and resolution notes are private instance-owned data.

## Configure

```ts
const contrail = new Contrail({
  db,
  namespace: "example.app",
  collections: { post: { collection: "example.app.post" } },
  moderation: {
    moderators: ["did:plc:YOUR_MODERATOR"],
    // reports: false, // disable XRPC report routes (no serviceAuth needed)
  },
  serviceAuth: {
    audience: "did:web:api.example.com#contrail",
    methods: [], // report/inbox routes are protected automatically
  },
  labels: {
    sources: [
      {
        did: "did:plc:ar7c4by46qjdydhdevvrndac",
        backfill: false,
        enforce: true,
        subjects: "known",
        values: ["!takedown", "!hide", "!warn", "porn", "sexual", "nudity", "graphic-media", "spam"],
      },
    ],
  },
});
await contrail.init();
```

Run `contrail lexicons generate` after enabling moderation. Don't list moderator DIDs inside `labels.sources` — they are added automatically as records-backed sources. Changing `moderators` or label trust (`enforce`, `values`, `subjects`) runs a paged background policy job without rebuilding DDL or FTS; pass `{ deferModerationPolicyJob: true }` to `init()` on request paths (`createWorker` does this automatically).

## Public moderator actions & overrides

Publish `tools.atmo.moderation.action` records to a configured moderator's repo:

```json
{
  "$type": "tools.atmo.moderation.action",
  "subject": "did:plc:SUBJECT",
  "action": "!takedown",
  "createdAt": "2026-10-05T12:00:00Z"
}
```

- `subject`: DID (hides entire account) or AT URI (hides that record; optional `subjectCid` pins one version, optional `expiresAt` sets expiry).
- `!hide` / `!takedown` enforce in SQL (`404` on `getRecord`/`getProfile`, excluded from lists, search, feeds, and relation counts). Other values attach as presentation labels.
- **Never put reasons, reporter identities, or notes in public actions** — the validator rejects extra fields; keep private context in reports.
- Delete the action record to undo it. Live ingestion + periodic PDS reconciliation keep actions in sync.
- **Overrides:** set `"action": "override"` (with optional `labels` and `src`) to suppress older external labeler claims on that subject. Overrides never affect moderator actions or account state.

## Account lifecycle

Jetstream account events apply automatically for any actor this instance holds data for:

- `active: false` (`deleted`, `deactivated`, `takendown`, `suspended`) hides the actor and all their records in SQL without purging rows.
- Reactivation restores visibility unless another hide/takedown applies.
- Built-in queries enforce visibility automatically. In custom raw-SQL queries, filter with `visibleRecordSql(alias)`.

## Private reports

### Standalone Worker (service-auth XRPC)

Report routes require a method-bound service JWT (`com.atproto.moderation.createReport`, `<namespace>.moderation.listReports`, `<namespace>.moderation.resolveReport`).

Store reports in a **separate stable database** so rebuilding the projection DB never wipes reports or rate-limit state:

```ts
// Cloudflare Worker:
export default createWorker(config, { reportsBinding: "REPORTS_DB" });

// Custom server:
import { initModerationReports } from "@atmo-dev/contrail";
await initModerationReports(reportsDb);
const app = contrail.app({ reportsDb });
```

### Embedded server (session auth)

If your app already has server-side sessions, set `moderation.reports: false` and call `createModerationReports` directly:

```ts
import { createModerationReports, initModerationReports } from "@atmo-dev/contrail";

await initModerationReports(reportsDb);
const reports = createModerationReports({ config: contrail.config, projectionDb, reportsDb });

await reports.create(session.did, { subject, reasonType, reason });
await reports.list(session.did, { status: "open", limit: 50, cursor });
await reports.resolve(session.did, { id, resolution, actionUri });
```

Your app owns session auth, CSRF protection, body limits, and `Cache-Control: no-store` on private responses.

### Client helpers (`@atmo-dev/contrail/moderation`)

Browser- and server-safe helpers: `submitReport`, `listReports`, `resolveReport`, `loadReportInboxes`, `createModerationAction`, `deleteModerationAction`, `moderationOAuthScope`.

```ts
import { moderationOAuthScope, submitReport } from "@atmo-dev/contrail/moderation";

const service = {
  endpoint: "https://api.example.com",
  audience: "did:web:api.example.com#contrail",
  namespace: "example.app",
};
const scope = moderationOAuthScope(service); // pass `true` for moderator inbox scopes
await submitReport({
  client, // authenticated @atcute/client
  service,
  subject: { $type: "com.atproto.admin.defs#repoRef", did },
  reasonType: "com.atproto.moderation.defs#reasonSpam",
  reason,
});
```

Use `@atmo-dev/kit` for moderation UI components (`ModerationGate`, `ReportDialog`, `ModerationConsole`).

## Operational caveats

- **Outbox is not moderation-filtered:** outbox consumers still receive records for hidden actors and do not receive account-lifecycle/label events — check visibility before republishing in downstream search/mirrors.
- **Purge external caches:** clear app-owned CDN / OG-image caches when hiding a subject.
- **No silent report migration:** without `reportsDb`/`reportsBinding`, reports fall back to the projection DB and are lost if you replace it.
