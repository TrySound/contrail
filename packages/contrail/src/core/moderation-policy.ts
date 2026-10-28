import type { ContrailConfig, Database, Statement } from "./types";
import { getMeta, getMetaValues } from "./db/meta";
import { getDialect, isPostgresDialect } from "./dialect";
import {
  HIDE_VALUES_SQL,
  flushModerationDirtyStatements,
  moderationDirtyToken,
} from "./moderation";

/** Last policy whose cheap state AND paged job both completed. */
const POLICY_APPLIED_KEY = "moderation_policy_applied";
/** Pending paged job for the current policy, if any. */
const POLICY_JOB_KEY = "moderation_policy_job";
const POLICY_GENERATION_KEY = "moderation_policy_generation";
const JOB_IS_CURRENT_SQL = "EXISTS (SELECT 1 FROM _contrail_meta WHERE key = ? AND value = ?)";
/** Meta keys `applyModerationPolicy` reads; callers may preload them. */
export const MODERATION_POLICY_META_KEYS = [POLICY_APPLIED_KEY, POLICY_JOB_KEY, POLICY_GENERATION_KEY];
const DEFAULT_PAGE_SIZE = 250;

interface NormalizedPolicy {
  v: 1;
  moderators: string[];
  sources: Array<{
    did: string;
    enforce: boolean;
    values: string[] | null;
    known: boolean;
  }>;
}

interface PolicyJob {
  fp: string;
  task: number;
  cursor: string | null;
  /** Sources whose stored labels are deleted entirely (moderator DIDs). */
  purge: string[];
  /** Sources whose stored labels are filtered to the current value allowlist. */
  prune: string[];
  /** Enforced sources whose stored hide labels may newly apply. */
  enforce: string[];
}

interface PolicyTask {
  /** One bounded page: statements applying it and the next cursor, or null
   * once the task is complete. */
  page(
    db: Database,
    cursor: string | null,
    pageSize: number,
    current: string,
  ): Promise<{ statements: Statement[]; next: string | null }>;
}

export interface ModerationPolicyJobOptions {
  deadline?: number;
  maxPages?: number;
  pageSize?: number;
  /** Meta values already read by the caller, keyed by meta key. */
  meta?: Map<string, string>;
}

function normalizePolicy(config: ContrailConfig): NormalizedPolicy {
  return {
    v: 1,
    moderators: [...(config.moderation?.moderators ?? [])].sort(),
    sources: (config.labels?.sources ?? [])
      .filter((s) => !s.records)
      .map((s) => ({
        did: s.did,
        enforce: !!s.enforce,
        values: s.values ? [...s.values].sort() : null,
        known: s.subjects === "known",
      }))
      .sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0)),
  };
}

/** Moderation trust and label admission policy. Tracked separately from the
 * schema fingerprint so policy edits never rerun DDL or rebuild FTS. */
export function moderationPolicyFingerprint(config: ContrailConfig): string {
  return JSON.stringify(normalizePolicy(config));
}

/** A persistent row serializes policy replacement, paged resets and backfill
 * commits on PostgreSQL. Unlike the job row, it survives job completion. */
export function lockModerationPolicyStatement(db: Database): Statement {
  return db.prepare("UPDATE _contrail_meta SET value = value WHERE key = ?")
    .bind(POLICY_GENERATION_KEY);
}

/** Opaque generation, including a nonce so a policy revert cannot admit an
 * old response. A worker with an obsolete config must not start new requests. */
export async function getModerationPolicyGeneration(
  db: Database,
  config: ContrailConfig,
): Promise<string | null> {
  const value = await getMeta(db, POLICY_GENERATION_KEY);
  if (!value) return null;
  return JSON.parse(value).fp === moderationPolicyFingerprint(config) ? value : null;
}

export function moderationPolicyGenerationSql(): string {
  return `EXISTS (SELECT 1 FROM _contrail_meta WHERE key = '${POLICY_GENERATION_KEY}' AND value = ?)`;
}

function backfillPolicy(values: string[] | null | undefined): string {
  return JSON.stringify({ values: values ? [...values].sort() : null });
}

function parseJob(value: string | null): PolicyJob | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as PolicyJob;
  } catch {
    return null;
  }
}

function parseApplied(value: string | null): NormalizedPolicy | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as NormalizedPolicy;
  } catch {
    return null;
  }
}

/** Find the upper key of one page so the page's work is a bounded key range
 * `(cursor, upper]`. A non-unique key covers all rows sharing the last key. */
async function pageRange(
  db: Database,
  table: string,
  key: string,
  filter: string,
  args: unknown[],
  cursor: string | null,
  pageSize: number,
): Promise<{ lower: string; upper: string | null; full: boolean }> {
  const lower = cursor ?? "";
  const rows = await db
    .prepare(
      `SELECT ${key} AS k FROM ${table} WHERE ${filter ? `${filter} AND ` : ""}${key} > ?
      ORDER BY ${key} LIMIT ?`,
    )
    .bind(...args, lower, pageSize)
    .all<{ k: string }>();
  return {
    lower,
    upper: rows.results.at(-1)?.k ?? null,
    full: rows.results.length === pageSize,
  };
}

/** Hold the job row for the whole write batch on PostgreSQL. Subsequent
 * statements then see a fresh READ COMMITTED snapshot after any previous
 * runner/replacement commits. SQLite and D1 already serialize write batches.
 * Policy replacement takes this same lock before changing source trust. */
function lockPolicyJobStatement(db: Database): Statement {
  return db
    .prepare("UPDATE _contrail_meta SET value = value WHERE key = ?")
    .bind(POLICY_JOB_KEY);
}

/** Delete a source's stored labels, optionally only values outside `values`. */
function pruneTask(src: string, values: string[] | null): PolicyTask {
  return {
    async page(db, cursor, pageSize, current) {
      const r = await pageRange(db, "labels", "uri", "src = ?", [src], cursor, pageSize);
      if (r.upper === null) return { statements: [], next: null };
      // One JSON parameter: an allowlist may exceed D1's bound-parameter limit.
      const admitted = isPostgresDialect(getDialect(db))
        ? "SELECT jsonb_array_elements_text(CAST(? AS jsonb))"
        : "SELECT value FROM json_each(?)";
      const filter = values?.length ? ` AND val NOT IN (${admitted})` : "";
      return {
        statements: [
          db
            .prepare(`DELETE FROM labels WHERE src = ? AND uri > ? AND uri <= ?${filter} AND ${JOB_IS_CURRENT_SQL}`)
            .bind(src, r.lower, r.upper, ...(values?.length ? [JSON.stringify(values)] : []), POLICY_JOB_KEY, current),
        ],
        next: r.full ? r.upper : null,
      };
    },
  };
}

/** Mark the subjects selected from a bounded key range dirty and recompute
 * their enforcement state in the same batch. */
function recomputeTask(
  config: ContrailConfig,
  table: string,
  key: string,
  subject: string,
  filter: string,
  args: unknown[],
  markFilter = "",
): PolicyTask {
  return {
    async page(db, cursor, pageSize, current) {
      const r = await pageRange(db, table, key, filter, args, cursor, pageSize);
      if (r.upper === null) return { statements: [], next: null };
      const token = moderationDirtyToken();
      return {
        statements: [
          db
            .prepare(
              `INSERT INTO moderation_dirty (token, subject)
              SELECT DISTINCT CAST(? AS TEXT), ${subject} FROM ${table}
              WHERE ${filter ? `${filter} AND ` : ""}${key} > ? AND ${key} <= ?${markFilter}
                AND ${JOB_IS_CURRENT_SQL}
              ON CONFLICT(token, subject) DO NOTHING`,
            )
            .bind(token, ...args, r.lower, r.upper, POLICY_JOB_KEY, current),
          // A stale page inserts no dirty subjects. The token-scoped flush
          // therefore cannot change hidden state or enqueue recounts either.
          ...flushModerationDirtyStatements(db, config, token),
        ],
        next: r.full ? r.upper : null,
      };
    },
  };
}

/** Requeue first-seen backfill for a known-subject source whose value policy
 * changed: reset existing queue rows, then enqueue every stored identity. The
 * policy row is written with the last page, so an interrupted job resumes. */
function requeueTask(src: string, values: string[] | null): PolicyTask {
  const policy = backfillPolicy(values);
  return {
    async page(db, cursor, pageSize, current) {
      let phase = 0;
      let position: string | null = null;
      if (cursor === null) {
        const current = await db
          .prepare("SELECT 1 FROM label_backfill_sources WHERE src = ? AND policy = ?")
          .bind(src, policy)
          .first();
        if (current) return { statements: [], next: null };
      } else [phase, position] = JSON.parse(cursor) as [number, string];
      if (phase === 0) {
        const r = await pageRange(db, "label_backfill_queue", "did", "src = ?", [src], position, pageSize);
        return {
          statements:
            r.upper === null
              ? []
              : [
                  db
                    .prepare(
                      `UPDATE label_backfill_queue SET completed = 0, cursor = NULL, retries = 0, next_attempt_at = 0,
                        generation = generation + 1
                      WHERE src = ? AND did > ? AND did <= ? AND ${JOB_IS_CURRENT_SQL}`,
                    )
                    .bind(src, r.lower, r.upper, POLICY_JOB_KEY, current),
                ],
          next: JSON.stringify(r.full ? [0, r.upper] : [1, ""]),
        };
      }
      const r = await pageRange(db, "identities", "did", "", [], position, pageSize);
      const statements =
        r.upper === null
          ? []
          : [
              db
                .prepare(
                  `INSERT INTO label_backfill_queue (src, did)
                  SELECT CAST(? AS TEXT), did FROM identities WHERE did > ? AND did <= ?
                    AND ${JOB_IS_CURRENT_SQL}
                  ON CONFLICT(src, did) DO NOTHING`,
                )
                .bind(src, r.lower, r.upper, POLICY_JOB_KEY, current),
            ];
      if (r.full) return { statements, next: JSON.stringify([1, r.upper]) };
      statements.push(
        db
          .prepare(
            `INSERT INTO label_backfill_sources (src, policy)
            SELECT CAST(? AS TEXT), CAST(? AS TEXT) WHERE ${JOB_IS_CURRENT_SQL}
            ON CONFLICT(src) DO UPDATE SET policy = excluded.policy`,
          )
          .bind(src, policy, POLICY_JOB_KEY, current),
      );
      return { statements, next: null };
    },
  };
}

/** Deterministic task list for a job: prune first, then recompute hidden
 * state (enforcement correctness), then requeue backfill. */
function policyTasks(config: ContrailConfig, job: PolicyJob): PolicyTask[] {
  const sources = (config.labels?.sources ?? []).filter((s) => !s.records);
  const tasks: PolicyTask[] = job.purge.map((src) => pruneTask(src, null));
  for (const s of sources)
    if (s.values && job.prune.includes(s.did)) tasks.push(pruneTask(s.did, s.values));
  const hide = ` AND action IN (${HIDE_VALUES_SQL})`;
  tasks.push(
    // Currently hidden subjects may lose trust, values or moderators.
    recomputeTask(config, "moderation_hidden", "subject", "subject", "", []),
    // Moderator actions and overrides may gain or lose trust.
    recomputeTask(config, "moderation_actions", "uri", "subject", "", [], hide),
    recomputeTask(config, "moderation_overrides", "uri", "subject", "", []),
    // Stored hide labels from newly enforced sources may now apply.
    ...job.enforce.map((src) =>
      recomputeTask(config, "labels", "uri", "uri", "src = ?", [src], ` AND val IN (${HIDE_VALUES_SQL})`),
    ),
  );
  for (const s of sources)
    if (s.subjects === "known") tasks.push(requeueTask(s.did, s.values ?? null));
  return tasks;
}

/** Apply a changed moderation policy. Only the small source table is
 * rewritten synchronously; label pruning, hidden-state recomputation and
 * backfill requeueing are a durable paged job. A short inline run completes
 * small instances immediately; larger ones continue in moderation cycles. */
export async function applyModerationPolicy(
  db: Database,
  config: ContrailConfig,
  options: ModerationPolicyJobOptions = {},
): Promise<void> {
  const fp = moderationPolicyFingerprint(config);
  const meta = options.meta ?? (await getMetaValues(db, MODERATION_POLICY_META_KEYS));
  const applied = meta.get(POLICY_APPLIED_KEY) ?? null;
  const job = parseJob(meta.get(POLICY_JOB_KEY) ?? null);
  if (!job && applied === fp && meta.has(POLICY_GENERATION_KEY)) return;
  if (job?.fp !== fp || !meta.has(POLICY_GENERATION_KEY)) {
    const policy = normalizePolicy(config);
    // An unfinished job may already have changed materialized hiding or
    // pruned labels. A source is unchanged only relative to BOTH the last
    // completed policy and the interrupted one, including on a revert.
    const predecessors = [parseApplied(applied)];
    if (job) predecessors.push(parseApplied(job.fp));
    const before = predecessors.map((p) => new Map(p?.sources.map((s) => [s.did, s])));
    const unchanged = (did: string, test: (s: NormalizedPolicy["sources"][number]) => boolean) =>
      before.every((sources) => sources.has(did) && test(sources.get(did)!));
    const oldModerators = (
      await db
        .prepare("SELECT did FROM moderation_sources WHERE moderator = 1")
        .all<{ did: string }>()
    ).results.map((r) => r.did);
    const union = (...lists: string[][]) => [...new Set(lists.flat())].sort();
    const next: PolicyJob = {
      fp,
      task: 0,
      cursor: null,
      // Also clears label summaries written by earlier action projections.
      purge: union(job?.purge ?? [], oldModerators, policy.moderators),
      prune: union(
        job?.prune ?? [],
        policy.sources
          .filter((s) => s.values && !unchanged(s.did, (o) => JSON.stringify(o.values) === JSON.stringify(s.values)))
          .map((s) => s.did),
      ),
      enforce: union(
        job?.enforce ?? [],
        policy.sources
          .filter((s) => s.enforce && !unchanged(s.did, (o) => o.enforce))
          .map((s) => s.did),
      ),
    };
    const sources = new Map<string, { moderator: number; enforced: number }>();
    for (const s of policy.sources)
      sources.set(s.did, { moderator: 0, enforced: s.enforce ? 1 : 0 });
    for (const did of policy.moderators)
      sources.set(did, { moderator: 1, enforced: 1 });
    const known = policy.sources.filter((s) => s.known).map((s) => s.did);
    await db.batch([
      // Acquire the permanent policy lock and invalidate in-flight backfills
      // before changing trust or starting any paged queue resets.
      db.prepare(
        "INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(POLICY_GENERATION_KEY, JSON.stringify({ fp, token: crypto.randomUUID() })),
      lockPolicyJobStatement(db),
      db.prepare("DELETE FROM moderation_sources"),
      ...[...sources].map(([did, s]) =>
        db
          .prepare("INSERT INTO moderation_sources (did, moderator, enforced) VALUES (?, ?, ?)")
          .bind(did, s.moderator, s.enforced),
      ),
      known.length
        ? db
            .prepare(`DELETE FROM label_backfill_sources WHERE src NOT IN (${known.map(() => "?").join(",")})`)
            .bind(...known)
        : db.prepare("DELETE FROM label_backfill_sources"),
      // Pruning may already have removed labels even if a replacement reverts
      // to the completed policy. Force known-source backfill to recover them.
      ...known
        .filter((src) => next.prune.includes(src) || next.purge.includes(src))
        .map((src) => db.prepare("DELETE FROM label_backfill_sources WHERE src = ?").bind(src)),
      db
        .prepare(
          "INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(POLICY_JOB_KEY, JSON.stringify(next)),
    ]);
  }
  await runModerationPolicyJob(db, config, {
    deadline: options.deadline ?? Date.now() + 3_000,
    maxPages: options.maxPages ?? 50,
    pageSize: options.pageSize,
  });
}

/** Advance the pending policy job by bounded pages. Each page's work and the
 * job checkpoint commit together. Every mutation is conditional on owning the
 * current checkpoint, under the job row lock, so superseded/concurrent runners
 * cannot commit stale work. Returns the pages attempted. */
export async function runModerationPolicyJob(
  db: Database,
  config: ContrailConfig,
  options: ModerationPolicyJobOptions = {},
): Promise<number> {
  const deadline = options.deadline ?? Date.now() + 10_000;
  const maxPages = options.maxPages ?? 50;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const raw = await getMeta(db, POLICY_JOB_KEY);
  let job = parseJob(raw);
  // A job for another policy belongs to a different deployment's config.
  if (!job || job.fp !== moderationPolicyFingerprint(config)) return 0;
  let current = raw!;
  const tasks = policyTasks(config, job);
  let pages = 0;
  while (pages < maxPages && Date.now() < deadline) {
    if (job.task >= tasks.length) {
      await db.batch([
        lockModerationPolicyStatement(db),
        lockPolicyJobStatement(db),
        db
          .prepare(
            `INSERT INTO _contrail_meta (key, value) SELECT CAST(? AS TEXT), CAST(? AS TEXT)
            WHERE EXISTS (SELECT 1 FROM _contrail_meta WHERE key = ? AND value = ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .bind(POLICY_APPLIED_KEY, job.fp, POLICY_JOB_KEY, current),
        db
          .prepare("DELETE FROM _contrail_meta WHERE key = ? AND value = ?")
          .bind(POLICY_JOB_KEY, current),
      ]);
      break;
    }
    const { statements, next } = await tasks[job.task]!.page(db, job.cursor, pageSize, current);
    const advanced: PolicyJob =
      next === null
        ? { ...job, task: job.task + 1, cursor: null }
        : { ...job, cursor: next };
    const serialized = JSON.stringify(advanced);
    await db.batch([
      lockModerationPolicyStatement(db),
      lockPolicyJobStatement(db),
      ...statements,
      db
        .prepare("UPDATE _contrail_meta SET value = ? WHERE key = ? AND value = ?")
        .bind(serialized, POLICY_JOB_KEY, current),
    ]);
    pages++;
    if ((await getMeta(db, POLICY_JOB_KEY)) !== serialized) break;
    job = advanced;
    current = serialized;
  }
  return pages;
}
