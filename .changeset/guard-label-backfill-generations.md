---
"@atmo-dev/contrail": patch
---
Guard first-seen label backfill writes and checkpoints with policy and queue generations inside their transaction. In-flight requests can no longer undo a changed policy, overwrite a reset queue row, or apply duplicate workers' late responses. Schema version 16 adds a generation column to existing backfill queues; initialization migrates it before running policy maintenance.
