# Labels

Contrail can subscribe to AT Protocol labelers and attach their labels to records and profiles.

## Configure

```ts
export default {
  namespace: "com.example",
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
  labels: {
    sources: [
      { did: "did:plc:ar7c4by46qjdydhdevvrndac" },
    ],
  },
};
```

Normal `contrail backfill`, Worker cron ingestion, and `runPersistent()` include configured labelers automatically. Scheduled cycles connect to all external labelers concurrently under a shared deadline, so an open or slow stream cannot starve later sources. An explicit source `endpoint` always takes precedence over the cached endpoint, including after cursor checkpoints.

## Author self-labels

Records and profile views expose author declarations separately as
`selfLabels: [{ val: "nudity" }]`. Contrail reads only the root canonical
`labels: { $type: "com.atproto.label.defs#selfLabels", values: [...] }`
container; the original `value` is unchanged. At most 10 entries are admitted,
with nonempty values of at most 128 UTF-8 bytes. Malformed entries are skipped,
exact duplicates are removed, and oversized containers are ignored.

Self-labels are normalized at read time, including relation/reference previews,
feeds, pipeline queries, cached/fetched profiles, and private moderator previews.
They require no labeler configuration, database migration, backfill or extra
queries. Removing them in a new record version removes them from the next
response. Custom handlers can use the exported `extractSelfLabels(value)` helper.

These are **author declarations**, not trusted labeler claims: no synthetic
`src`, timestamp, signature or expiry is added, and they never affect backend
visibility, counts or pagination. Profile declarations belong to that profile
record, not all posts from its author. They are not selected by
`Atproto-Accept-Labelers` or reported in `Atproto-Content-Labelers`.

`@atmo-dev/ui/moderation` accepts them through
`moderate({ labels: record.labels, selfLabels: record.selfLabels,
subject: record.uri, subjectCid: record.cid, author: { did: record.did } })`.
Pass the rich decision to `ModerationGate`. Built-in `porn`, `sexual`, `nudity`
and `graphic-media` declarations cover media with author attribution; custom
values are informational. Operator `!` values cannot create takedowns or
sign-in restrictions. Use a profile's own URI/decision with `kind: "profile"`
for profile media/avatar gates; never flatten profile declarations into posts.

Regenerate Lexicons/types after upgrading. Generated views include the standard
self-label dependency, with a bundled offline fallback when the project has no
local `com.atproto.label.defs` document. Project-provided documents win.

## Select labelers

A request chooses labelers with the standard header:

```text
Atproto-Accept-Labelers: did:plc:ar7c4by46qjdydhdevvrndac
```

Use `?labelers=did:plc:...` when setting a header is inconvenient. Without either, Contrail uses `labels.defaults`, or all configured sources when defaults are omitted. Set `defaults: []` to require callers to opt in.

Selected labels appear as `record.labels`. Account labels appear on hydrated profile entries. The response's `Atproto-Content-Labelers` header reports which configured labelers were applied.

Contrail drops expired labels, applies CID-pinned labels only to the matching record version, treats newer `neg: true` labels as retractions, and rejects labels whose `cts` is more than five minutes in the future.

Per-source `values` filters stored label values; `subjects: "known"` restricts
subjects to indexed identities and schedules durable first-seen `queryLabels`
backfill. Stored retractions always pass admission. `backfill: false` starts a
new stream from now rather than replaying its entire history. If that first
connection receives no frame (a quiet labeler), there is no sequence number to
resume from, so the next cycle replays from the beginning and keeps only
labels created after the first connection (allowing five minutes of clock
skew). Replay may span multiple cycles: each resumes from its saved cursor
and retains that timestamp cutoff. Enabling historical backfill disables the
cutoff; it does not reset an existing cursor.

Set `enforce: true` to enforce `!hide` and `!takedown` independently of caller
labeler selection. Account labels are included on returned records as well as
profiles, including hydrated relation/reference previews. Moderator action
records, overrides, account lifecycle and private reports are documented in
[Moderation](./moderation.md). `@atmo-dev/ui/moderation` provides presentation
helpers; Contrail itself does not publish a signed label stream. Label
signatures are stored but are not currently verified.
