---
"@atmo-dev/contrail": patch
---

Pump external labelers concurrently during scheduled ingestion so a long-lived first stream cannot starve later sources. Include endpoint resolution in each cycle's time budget. Honor explicit labeler endpoint overrides when resuming cursor-only checkpoints or replacing a cached endpoint.

With `backfill: false`, a quiet labeler whose first "from now" connection saw no frame no longer skips labels issued between scheduled cycles: the next cycle replays from the beginning, keeping only labels created after that first connection (allowing five minutes of clock skew). The cutoff persists across partial replay cycles and reconnects, even after a nonzero cursor is saved.
