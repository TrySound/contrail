---
"@atmo-dev/contrail": patch
---

Guard live label subscriptions with the current moderation policy generation inside label, visibility and cursor transactions. Obsolete subscriptions close without advancing shared cursors or reconnecting with stale admission rules, including after policy reverts. Treat record-scoped hidden profiles as hidden rather than missing: skip PDS read-through and identity-only fallbacks, return 404 when no profile remains visible, and honor CID pins independently across configured profile collections.
