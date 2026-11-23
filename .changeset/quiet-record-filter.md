---
"@atmo-dev/contrail": minor
---

Add `recordFilterTombstones` to collection config. With `false`, a record rejected by `recordFilter` that has no stored version is dropped without writing a tombstone, so a filter that rejects most of a high-volume collection no longer costs a row per rejected record. A rejected update to an indexed record is still removed. The default is unchanged.
