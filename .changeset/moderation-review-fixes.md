---
"@atmo-dev/contrail": patch
---

Drop Jetstream account events for actors the instance holds no data for before they spend the scheduled `maxAccountUpdates` budget or persistent flushes; persistent ingestion keeps only the newest event per actor and flushes account events on its timer. Queue relation recounts only when a subject's visible hidden state actually changes. Apply moderation policy once per `Contrail` instance and database rather than on every `ingest()` tick. Resume moderator action listings larger than one cycle's budget from a durable cursor (deletions are still inferred only from a complete listing). Only accept reports about indexed subjects, retry colliding random report IDs, and validate action `subjectCid` values as CIDs.
