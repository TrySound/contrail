---
"@atmo-dev/contrail": patch
---

Preserve millisecond creation timestamps for labels, moderator actions and overrides so same-second historical replay cannot undo newer enforcement state. Schema version 17 atomically upgrades existing creation timestamps exactly once; stop older Contrail processes before upgrading because the stored timestamp unit changes.

Keep validated moderator-action pages and their resume cursor when a later page times out or fails. Transient failures no longer discard durable sweep progress, and incomplete listings never infer deletions.
