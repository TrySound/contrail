# Moderation and account lifecycle

Contrail enforces moderation in SQL, independently of `Atproto-Accept-Labelers`.
Moderator actions are public repository records; reports and resolution notes
are private instance-owned data. Nothing is published to a repository when a
user submits a report.

## Configure

```ts
const contrail = new Contrail({
  db,
  namespace: "example.app",
  collections: { post: { collection: "example.app.post" } },
  moderation: { moderators: ["did:plc:YOUR_MODERATOR"] },
  serviceAuth: {
    audience: "did:web:api.example.com#contrail",
    methods: [], // report/inbox methods are protected automatically
  },
  labels: {
    sources: [{
      did: "did:plc:ar7c4by46qjdydhdevvrndac",
      backfill: false,
      enforce: true,
      subjects: "known",
      values: ["!takedown", "!hide", "!warn", "porn", "sexual", "nudity",
               "graphic-media", "spam"],
    }],
  },
});
await contrail.init();
```

For enforcement without reports, set `moderation.reports: false`; no service
audience is required. Nothing enables Bluesky's labeler implicitly. `spam` is
attached, not hidden. Moderator DIDs become records-backed label sources and
are never contacted as WebSocket labelers; listing a moderator DID in
`labels.sources` as well is a configuration error. If you set `labels.defaults`, the
moderator DIDs are appended to it so their non-hide labels attach by default.

Run `contrail lexicons generate` after changing configuration. Contrail emits
`tools.atmo.moderation.action` and the report method Lexicons, with the standard
report dependencies in the pull list. The action NSID is the current framework
name; register/pin it before publishing it as a permanent ecosystem contract.

## Public actions

Write `tools.atmo.moderation.action` to a configured moderator's repo:

```json
{
  "$type": "tools.atmo.moderation.action",
  "subject": "did:plc:SUBJECT",
  "action": "!takedown",
  "createdAt": "2026-10-05T12:00:00Z"
}
```

`subject` is a DID or a DID-authority record URI. Optional `subjectCid` pins a
record action to one version. `expiresAt` is an ISO timestamp. Actions are
**global** across all instances trusting the author. Never include reasons,
evidence, reporter identities or notes: the ingestion validator rejects extra
fields to discourage accidental disclosure, but the PDS record is already
public at that point. Use the private report inbox for those fields.

- `!hide` / `!takedown`: hide records and profiles. A DID action hides the whole
  account; a record action hides only that record/version.
- Other values: attach labels for presentation.
- Delete an action record to undo it. Duplicate action records remain effective
  until all applicable actions have been removed. An update retracts the old
  subject/value and applies the new one atomically. Editing an action into an
  invalid record retracts it.
- `createdAt` is clamped to the projection time, so a forward-dated action
  cannot pre-empt labels issued before it was actually observed.
- Untrusted authors cannot write moderation state, even through backfill or
  notify ingestion. The action collection has no generic public query routes
  and is excluded from ordinary network-wide discovery/dependent backfill.

`contrail.ingest()` and `contrail.runPersistent()` reconcile a bounded complete
PDS listing for each moderator (each cron tick; every 30 s when persistent).
Only actions whose CID differs from the indexed one, and missed deletions, are
written: an unchanged repository costs reads only. Incomplete listings, failed
pages and timeouts never infer deletions. Live actions enter the same source-ordering/projector as app records.
Action records remain independent assertions in `moderation_actions` and are
exposed as labels through `moderation_effective_labels`. CID pins and expiry
are evaluated per action: a newer expired or differently pinned action cannot
cancel another applicable action. Authenticity relies on the trusted repo
source, not on a label signature. Label signatures are not verified yet;
CBOR and JSON signature bytes are preserved for storage, not treated as proof.

Known-subject label backfill is queued by record projection and persisted
identity writes. Each cycle queries up to 100 due DIDs with 8 concurrent
requests (about 100 per cron minute; persistent mode loops without waiting
while work remains). Enabling a source on a large instance replays every known
identity at that rate. The first identity write rechecks an earlier record-only
backfill; routine refreshes do not restart completed work. Changing a source's
value allowlist resets its historical query checkpoints and drops stored values
no longer admitted. Labels and each page checkpoint commit together, with
bounded work and durable retries. The labeler must support the standard DID
and trailing-`*` URI patterns; observe real results/pagination before rollout.

### Overrides

```json
{
  "$type": "tools.atmo.moderation.action",
  "subject": "did:plc:SUBJECT",
  "action": "override",
  "labels": ["spam"],
  "src": "did:plc:ar7c4by46qjdydhdevvrndac",
  "createdAt": "2026-10-05T12:00:00Z"
}
```

An override suppresses older external labels on that exact subject. Omit `labels`
for all values, or `src` for all external labelers. Later labels apply again.
An override with `subjectCid` only suppresses labels pinned to that same CID;
use an unpinned override for unpinned labels.
Deleting/expiring the override restores still-active labels. Overrides affect
hydration and enforcement, but **never** moderator labels or account state.
Timestamps currently have label-pipeline second precision: same-second external
labels are not considered older than an override.

## Account lifecycle

Jetstream v2 account events are applied regardless of moderation config, but
only for actors this instance holds data for (an identity or any indexed
record). Both active and inactive events for such an actor store state and
ordering checkpoints, so a delayed inactive event cannot undo a newer initial
active event. Later events update the stored row. Network-wide account traffic
for unknown DIDs writes
nothing. An actor that is already inactive cannot publish new records; the
remaining gap is a repo backfilled later from a PDS that still serves it.
`active: false` hides the actor, including unknown inactive status values.
`deleted`, `deactivated`, `takendown`, and `suspended` are hidden states.
Duplicate/stale events cannot undo newer state. Lifecycle state and the live
source checkpoint commit in the same transaction, including account-only
batches and retrying persistent flushes. Scheduled drains keep the newest event
per actor and stop at `maxAccountUpdates` distinct actors (default 500), which
is separate from the record `maxCandidates` budget.

Reactivation restores retained data unless another action/label still hides it.
Deletion currently retains data invisibly; it is **not** interpreted as an
unverified permanent purge. Public relation counts/hydration, references, feeds,
search and pagination exclude hidden actors and records. Feed caches and FTS
rows remain retained, so reversible status changes do not require rebuilding.
Old v1 bootstrap/Alluvium sources still advertise `accountLifecycle: false`;
a fresh snapshot alone does not establish account state. Do not claim lifecycle
coverage for a source without that capability.

### Enforcement implementation and cost

`moderation_hidden` is a materialized, indexed table. Whenever a hide label,
moderator action, override or account state changes, the affected subjects are
recomputed in the same transaction as that change. External label collapse happens **before**
expiry: an expired replacement or retraction must not resurrect an older hide.
Moderator actions are evaluated independently rather than collapsed, so all
applicable actions must be deleted or expire before their hide is lifted.
Time is stored rather than swept: each row hides only while
`starts_at <= now < exp` (an expiring override delays `starts_at`), so expiry
needs no cron. Visibility checks are indexed point lookups per returned row.

Stored relation counts are public counts: they exclude hidden children whenever
a parent is recounted. When a subject's visibility changes, or reaches a stored
`starts_at`/`exp` boundary, its affected parents are queued in
`moderation_recount_queue` and recounted in bounded pages by the moderation
cycle. Counts, count filters, sorts and cursors all use the same stored columns
and stay mutually consistent. They can lag a takedown by one cycle.

Built-in queries and pipeline queries enforce policy. Custom raw-SQL handlers
must include `visibleRecordSql(alias)`; Contrail cannot rewrite arbitrary
application SQL. A hidden getRecord/getProfile returns the same 404 as a missing
subject.

## Private reports

Report routes always require a method-bound service JWT with the exact
fragmented audience:

- `com.atproto.moderation.createReport`: standard repoRef/strongRef subject and
  standard reason types. Request bodies have byte and read-time limits.
  Ten reports per reporter per one-hour quota window.
  Bounded request bodies and notes. Returns a standard integer report ID.
- `<namespace>.moderation.listReports`: moderator-only, open/resolved filtering,
  stable cursor pagination; private indexed subject previews include hidden
  records and effective labels without refetching the PDS.
- `<namespace>.moderation.resolveReport`: moderator-only, idempotent resolution,
  optional private note and associated public action URI.

Inbox responses are `Cache-Control: no-store`. Report IDs are scoped to the
instance: always retain the service endpoint alongside an ID when aggregating.

### Storage that survives fresh-generation rebuilds

For a single non-generational database the private tables are additive and are
never erased by `initSchema`. For fresh projection generations, bind a stable
**separate instance database**, not the candidate projection:

```ts
import { initModerationReports } from "@atmo-dev/contrail";
await initModerationReports(instanceReportsDb);
const app = contrail.app({ reportsDb: instanceReportsDb });
```

A Cloudflare Worker can use `createWorker(config, { reportsBinding: "REPORTS_DB" })`.
Keep that D1 binding unchanged when replacing `DB`. The handler uses the active
projection only for moderator previews; reports and rate-limit state stay in
the stable database. There is no automatic copy between arbitrary databases.

## Client helpers

`@atmo-dev/contrail/moderation` exports `submitReport`, `listReports`,
`resolveReport`, `loadReportInboxes`, `createModerationAction`,
`deleteModerationAction`, and `moderationOAuthScope`. It has no server
dependencies and works in browsers and server runtimes.

Pass the authenticated atcute `Client` from the user's OAuth session (for
example from `@svelte-atproto/oauth`). Configure service references in your
app, not from report input:

```ts
import { moderationOAuthScope, submitReport } from "@atmo-dev/contrail/moderation";

const service = {
  endpoint: "https://api.example.com",
  audience: "did:web:api.example.com#contrail",
  namespace: "example.app",
};
// Include this permission in OAuth client metadata; users must reauthorize.
const reportScope = moderationOAuthScope(service);
await submitReport({ client, service,
  subject: { $type: "com.atproto.admin.defs#repoRef", did },
  reasonType: "com.atproto.moderation.defs#reasonSpam", reason,
});
```

The helper mints `getServiceAuth` for the exact audience and method, sends that
service token to Contrail (never the OAuth bearer), and refuses redirects that
could leak it. Moderator sessions need `moderationOAuthScope(service, true)`
for every configured service plus repository create/delete permission for the
action collection. Do not request wildcard RPC permissions.

`@atmo-dev/ui/moderation` provides:

- `decideModeration(labels, prefs)` with content/media/profile decisions;
- `ModerationGate` (sensitive children are not rendered until disclosed; hard
  hides cannot be revealed), and `LabelBadge`;
- `ReportDialog` (reason, private text, callback, pending/error state);
- `ReportQueue`, `ReportCard`, `ModActionMenu`, and `ModerationConsole`.

All network calls are callbacks. `ModerationConsole` takes `onLoad`, `onAction`,
and `onResolve`: wire `onLoad` to `loadReportInboxes`, map subject repoRefs/
strongRefs to their DID/URI for the queue, write/delete public records in
`onAction`, and resolve each report in its original service in `onResolve`.
Partial load/resolve failures remain visible. Resolve notes are never passed
into the public action callback. The helpers return per-instance cursors for
apps that need deeper inbox pagination. The console can live on an app's `/mod`
route; it does not authenticate or grant privileges on its own.

Record responses include effective record **and author** labels, including
relation/reference previews, so gates do not depend on profile hydration.
Author declarations are returned separately as `selfLabels`, never mixed into
trusted `labels`. They require no source selection or stored moderation state;
profile declarations stay scoped to that profile record. Pass them to the UI's
`moderate()` with the enclosing record URI, author DID and CID to get attributed
media disclosure. Self-applied `!hide`/`!takedown` do not enforce anything. See
[Labels](./labels.md#author-self-labels).

Preference/UI disclosure is not a substitute for backend enforcement.

## Rollout and cache safety

Publish/upgrade all three packages before integrating an older app. Blento's
current checkout uses Contrail 0.5 and older atcute/OAuth APIs: that migration
must precede replacing its hardcoded denylist. Choose a moderator DID, create
the replacement takedown, confirm server-side 404s, and only then remove the
old protection. No account action should be published without operator review.

Purge app-owned image, OG-image and CDN caches when hiding a subject. The
record-only transactional change log does not currently emit lifecycle or
external-label changes; do not treat it as a complete purge signal. Configure
app purge hooks/short cache lifetimes until dedicated moderation notifications
are available. Illegal content may require deletion, PDS/operator escalation
and reporting to the appropriate authorities, not just a UI hide. Do not keep
copies of illegal material in reports or preview caches.
