---
"@atmo-dev/contrail": minor
---

Add shared moderation, public moderator action records and overrides, enforced SQL visibility, private method-bound report endpoints, bounded first-seen label backfill, and atomic Jetstream v2 account lifecycle state for known actors. Deleted/inactive actors retain data invisibly; reactivation restores retained projections subject to moderation. Enforcement uses a materialized, indexed `moderation_hidden` table; stored relation counts exclude hidden children and are recounted by a bounded queue when visibility changes. Scheduled drains gain a separate `maxAccountUpdates` budget. Reports may use stable instance-owned storage outside projection generations. Schema version 15 adds additive moderation/lifecycle tables and a view. Client helpers for reports, moderator inboxes and action records are available from `@atmo-dev/contrail/moderation`.
