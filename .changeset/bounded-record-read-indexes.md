---
"@atmo-dev/contrail": patch
---

Reduce unrelated-data reads during record deletion and equality-filtered listing. Feed items now have a URI index, and equality-queryable fields use `(field, time_us DESC, uri ASC)` indexes instead of redundant single-field indexes. Range indexes are unchanged. Chronological cursors expose their time bound so filtered deep pages can seek past newer matches while preserving URI tie-breaking and moderation visibility.

For an unchanged configuration, the preceding schema upgrades indexes in place without rebuilding FTS, recounting records, or resetting records and source progress. Replacement indexes are created before old indexes are removed, and interrupted upgrades can retry. Index construction incurs one-time database work; the feed URI index adds ongoing index writes per feed entry.
