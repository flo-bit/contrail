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

Expired labels are dropped, CID-pinned labels only match that version, newer `neg: true` labels retract prior ones, and labels with `cts` more than five minutes in the future are rejected. With `backfill: false` on a quiet labeler (no frame received on first connect), the next cycle replays from the beginning while keeping only labels created after the first connection (allowing five minutes of clock skew). Label signatures are stored but not currently verified.

## Author self-labels

Records and profiles with canonical `com.atproto.label.defs#selfLabels` expose `selfLabels: [{ val: "nudity" }]` automatically at read time — no labeler config or migration needed. Contrail admits up to 10 nonempty entries per record (max 128 UTF-8 bytes each), deduplicates exact duplicates, and ignores oversized containers; custom handlers can call `extractSelfLabels(value)`.

Self-labels are author declarations, not trusted labeler claims: they never affect SQL visibility, counts, or pagination, and `!hide`/`!takedown` self-labels do nothing. Contrail returns `labels` and `selfLabels` separately so client UIs can render disclosure gates with author attribution.

For SQL enforcement, moderator actions, account lifecycle, and private reports, see [Moderation](./moderation.md).
