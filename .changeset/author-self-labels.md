---
"@atmo-dev/contrail": minor
---

Expose canonical author declarations as a separate optional `selfLabels` field on record, profile, feed, relation/reference and private moderator preview views. Normalize current record metadata without database writes or extra queries; self-labels never enforce visibility or depend on accepted labelers. Export `extractSelfLabels` and `SelfLabel`, update generated view contracts, and bundle the standard label definitions as an offline fallback for complete service/type-generation bundles.
