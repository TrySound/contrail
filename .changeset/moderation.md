---
"@atmo-dev/contrail": minor
---

Add moderation: public moderator action records (`tools.atmo.moderation.action`) with overrides, per-source label trust (`enforce`, `values`, `subjects: "known"` with bounded first-seen `queryLabels` backfill), enforced SQL visibility, private method-bound report endpoints, and Jetstream v2 account lifecycle state.

- Enforcement uses an indexed, materialized `moderation_hidden` table, updated in the same transaction as each label, action, override or account change. Built-in queries, hydration, feeds, search, profiles and stored relation counts exclude hidden actors and records. Custom SQL can use the exported `visibleRecordSql(alias)`.
- Account lifecycle applies to every instance, with or without moderation config: deactivated, deleted, taken-down and suspended actors this instance holds data for are hidden, and reactivation restores their retained data. Scheduled drains gain a separate `maxAccountUpdates` budget (default 500).
- Moderator and label-source policy is tracked outside the schema fingerprint and applied by a bounded, resumable job, so policy edits never rebuild search indexes. `init()` accepts `deferModerationPolicyJob` to leave that job to moderation cycles; `createWorker` uses it for requests.
- Reports can live in stable instance-owned storage (`reportsDb`, `createWorker({ reportsBinding })`). Client helpers for reports, moderator inboxes and action records are available from `@atmo-dev/contrail/moderation`.
- Label `cts` values more than five minutes in the future are rejected, and label creation timestamps keep millisecond precision.
- Known-subject label backfill restarts pagination after an explicit `InvalidCursor` error; transient failures keep the saved cursor.

Schema version 17 adds the moderation, lifecycle and report tables and converts stored label creation timestamps from seconds to milliseconds exactly once. Stop older Contrail processes before upgrading, and run `contrail lexicons generate` after enabling moderation.
