---
"@atmo-dev/contrail": minor
"@atmo-dev/contrail-sync": minor
---

unify the per-space marker field on records as `space` everywhere. previously `listRecords` / `getRecord` HTTP responses used `space: <spaceUri>` while watch events and `WatchRecord` exposed it as `_space`. the underscored form was inconsistent with the surrounding fields (`uri`, `cid`, `did`, etc.) and forced consumers to remember which path produced which name.

**breaking.** anywhere you read `r._space` on a `WatchRecord` (or a watch event payload's `record._space` / `child._space`), rename to `r.space`. drop-in.

```ts
// before
if (record._space) ...

// after
if (record.space) ...
```

no migration needed for `listRecords` / `getRecord` consumers — that path was already `space`.
