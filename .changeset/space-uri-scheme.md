---
"@atmo-dev/contrail": minor
"@atmo-dev/contrail-sync": minor
"@atmo-dev/contrail-lexicons": minor
---

permissioned spaces now use the `ats://` scheme instead of `at://`. tracks the [permissioned data spec](https://dholms.leaflet.pub/3mhj6bcqats2o), which floats `ats://` as a distinct scheme so spaces can't be confused with atproto record URIs at any layer (logs, query params, dispatch, error messages).

```
- at://did:plc:alice/com.example.event.space/birthday
+ ats://did:plc:alice/com.example.event.space/birthday
```

what changed:
- `buildSpaceUri` / `parseSpaceUri` (`@atmo-dev/contrail`) emit / accept `ats://`. anything else returns `null` from `parseSpaceUri`.
- generated lexicons no longer claim `format: "at-uri"` on `spaceUri` params, on the `space` record-output field, or on `spaceView.uri` — they're plain `string`. (atproto's `at-uri` format would reject `ats://`.) regenerate committed `lexicons/generated/*` with `contrail-lex generate`; downstream `lex-cli generate` then emits `v.string()` instead of `v.resourceUriString()` for those fields.
- realtime topics are unchanged in shape (`space:<uri>`), but `<uri>` is now an `ats://` URI.
- record URIs (the `uri` on a record, the `appPolicyRef` field, `notifyOfUpdate` payloads) keep `at://` — those are still atproto record URIs.

**breaking.** anywhere you build a space URI by string concatenation (`` `at://${did}/${type}/${key}` ``), switch to `ats://` or call `buildSpaceUri()`. anywhere you persist space URIs in your own DB, migrate (`UPDATE … SET space_uri = REPLACE(space_uri, 'at://', 'ats://') WHERE space_uri LIKE 'at://%'`).
