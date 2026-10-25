---
"@atmo-dev/contrail": patch
---

Pump external labelers concurrently during scheduled ingestion so a long-lived first stream cannot starve later sources. Include endpoint resolution in each cycle's time budget. Honor explicit labeler endpoint overrides when resuming cursor-only checkpoints or replacing a cached endpoint.
