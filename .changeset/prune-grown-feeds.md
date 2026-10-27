---
"@atmo-dev/contrail": minor
---

Prune only the feeds an ingest batch grew. Before, ingesting any feed-mutating record set off a prune of the next 500 actors' feeds, whether or not those feeds had changed. Now ingest looks up the followers of the batch's authors, adds the batch's new or repointed followers, and prunes just those feeds. Constellation follower backfill prunes the feeds it fills. The rolling sweep still runs as the recovery pass, when a batch grows more feeds than one slice's budget, and after a failed Constellation backfill.

New exports: `pruneGrownFeeds` (with its `GrownFeedPruneResult` type) and `runGrownFeedPrune`.

**breaking.** `runGatedFeedPrune` now takes the applied events instead of a `feedTouched` boolean, plus an optional flag that asks for a sweep slice. If you call it yourself, pass the events instead of the flag:

```ts
// before
await runGatedFeedPrune(db, config, applied.some((e) => feedMutatingNsids.has(e.collection)));
// after
await runGatedFeedPrune(db, config, applied);
```
