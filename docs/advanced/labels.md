# Labels

Subscribe to AT Protocol labelers and attach labels (plus author self-labels) to records and profiles.

## Configure

```ts
export default {
  namespace: "com.example",
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
  labels: {
    defaults: ["did:plc:ar7c4by46qjdydhdevvrndac"], // optional; omit to default to all sources
    sources: [
      {
        did: "did:plc:ar7c4by46qjdydhdevvrndac",
        values: ["!takedown", "!hide", "!warn", "porn", "sexual", "nudity", "graphic-media", "spam"],
        subjects: "known", // only backfill/store for indexed identities
        backfill: false,   // start from now instead of replaying full labeler history
        enforce: true,     // hide !hide/!takedown in SQL regardless of caller headers
      },
    ],
  },
};
```

`contrail backfill`, Worker cron ingestion, and `runPersistent()` all ingest configured labelers automatically.

## Selecting labelers on requests

Callers choose labelers with the standard header (or `?labelers=did:plc:...`):

```text
Atproto-Accept-Labelers: did:plc:ar7c4by46qjdydhdevvrndac
```

Without either, Contrail uses `labels.defaults` (or all configured sources; set `defaults: []` to require opt-in). Applied labelers are echoed in `Atproto-Content-Labelers`, and attached on `record.labels` (including account labels and hydrated previews) and hydrated `profiles`.

Expired labels are dropped, CID-pinned labels only match that version, and newer `neg: true` labels retract prior ones. Label signatures are stored but not currently verified.

## Author self-labels

Records and profiles with canonical `com.atproto.label.defs#selfLabels` expose `selfLabels: [{ val: "nudity" }]` automatically at read time — no labeler config or migration needed.

Self-labels are author declarations, not trusted labeler claims: they never affect SQL visibility, counts, or pagination, and `!hide`/`!takedown` self-labels do nothing. Use `@atmo-dev/kit` moderation components to render disclosure gates for both `labels` and `selfLabels`.

For SQL enforcement, moderator actions, overrides, account lifecycle, and private reports, see [Moderation](./moderation.md).
