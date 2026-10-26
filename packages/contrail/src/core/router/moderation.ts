import type { Hono, Context } from "hono";
import type { Nsid } from "@atcute/lexicons/syntax";
import { isDid, isCid, parseResourceUri } from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database } from "../types";
import {
  recordsTableName,
  resolveCollectionKey,
  normalizeProfileConfig,
} from "../types";
import type { ServiceAuthGate } from "../service-auth";
import {
  MODERATION_ACTION_NSID,
  subjectDid,
  activeHiddenSql,
  knownAccountDids,
} from "../moderation";
import { hydrateLabels } from "../labels/hydrate";
import { batchedInQuery, formatRecord } from "./helpers";
import { REPORT_REASON_TYPES } from "../../moderation-contract";

export { REPORT_REASON_TYPES };

async function smallJson(c: Context): Promise<any> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Body timeout"));
      reader.cancel().catch(() => {});
    }, 5_000);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        reader.cancel().catch(() => {});
        throw new Error("Body too large");
      }
      parts.push(value);
    }
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  const parsed = JSON.parse(new TextDecoder().decode(body));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected object");
  return parsed;
}

/** The createReport Lexicon bounds `reason` by graphemes and UTF-8 bytes. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function withinReasonLimits(reason: string): boolean {
  if (new TextEncoder().encode(reason).length > 20_000) return false;
  let count = 0;
  for (const _ of graphemes.segment(reason)) if (++count > 2000) return false;
  return true;
}

interface ReportRow {
  id: string;
  reporter: string;
  subject_uri: string;
  subject_did: string;
  subject_cid: string | null;
  reason_type: string;
  reason: string | null;
  status: string;
  resolution: string | null;
  action_uri: string | null;
  created_at: number;
  resolved_at: number | null;
}

function subject(row: ReportRow) {
  return row.subject_cid
    ? {
        $type: "com.atproto.repo.strongRef",
        uri: row.subject_uri,
        cid: row.subject_cid,
      }
    : { $type: "com.atproto.admin.defs#repoRef", did: row.subject_did };
}

/** Reports are limited to subjects this instance indexes, so arbitrary DIDs
 * and URIs cannot fill the private inbox. Hidden subjects remain reportable. */
async function isIndexedSubject(
  db: Database,
  config: ContrailConfig,
  uri: string,
  did: string,
): Promise<boolean> {
  if (!uri.startsWith("at://"))
    return (await knownAccountDids(db, config, [did])).has(did);
  const key = resolveCollectionKey(config, parseResourceUri(uri).collection!);
  return (
    !!key &&
    !!(await db
      .prepare(`SELECT 1 FROM ${recordsTableName(key)} WHERE uri = ?`)
      .bind(uri)
      .first())
  );
}

interface ReportPreview {
  records: any[];
  labels: Record<string, unknown[]>;
  hidden: boolean;
}

/** Never use the public pipeline for moderator previews: moderators need the
 * locally indexed hidden subject too. No PDS fetch and no private data joins.
 * Batched per page: a fixed number of queries regardless of report count. */
async function previews(
  db: Database,
  config: ContrailConfig,
  rows: ReportRow[],
): Promise<Map<string, ReportPreview>> {
  const recordsByUri = new Map<string, any>();
  const uris = new Map<string, string[]>();
  const select = (key: string, list: string[]) =>
    uris.set(key, [...(uris.get(key) ?? []), ...list]);
  const profileConfigs = (config.profiles ?? []).map(normalizeProfileConfig);
  const profileUris = (did: string) =>
    profileConfigs.map((pc) => ({ pc, uri: `at://${did}/${pc.collection}/${pc.rkey ?? "self"}` }));
  for (const row of rows) {
    if (row.subject_uri.startsWith("at://")) {
      const key = resolveCollectionKey(config, parseResourceUri(row.subject_uri).collection!);
      if (key) select(key, [row.subject_uri]);
    } else
      for (const { pc, uri } of profileUris(row.subject_did))
        select(pc.shortName ?? pc.collection, [uri]);
  }
  for (const [key, list] of uris) {
    const nsid = config.collections[key]?.collection ?? key;
    const found = await batchedInQuery<any>(
      db,
      `SELECT * FROM ${recordsTableName(key)} WHERE uri IN (__IN__)`,
      [],
      [...new Set(list)],
    );
    for (const record of found)
      recordsByUri.set(record.uri, formatRecord({ ...record, collection: nsid }));
  }
  const subjects = [...new Set(rows.flatMap((r) => [r.subject_uri, r.subject_did]))];
  const labels = await hydrateLabels(
    db,
    subjects,
    config.labels?.sources.map((s) => s.did) ?? [],
    new Map([...recordsByUri.values()].map((r) => [r.uri, r.cid])),
  );
  const hiddenRows = await batchedInQuery<{ subject: string; cid: string }>(
    db,
    `SELECT subject, cid FROM moderation_hidden WHERE subject IN (__IN__) AND ${activeHiddenSql()}`,
    [],
    subjects,
  );
  const result = new Map<string, ReportPreview>();
  for (const row of rows) {
    const records = row.subject_uri.startsWith("at://")
      ? [recordsByUri.get(row.subject_uri)].filter(Boolean)
      : profileUris(row.subject_did).map(({ uri }) => recordsByUri.get(uri)).filter(Boolean);
    const cid = records[0]?.cid ?? row.subject_cid;
    result.set(row.id, {
      records,
      labels: Object.fromEntries(
        [row.subject_uri, row.subject_did].filter((s) => labels[s]).map((s) => [s, labels[s]!]),
      ),
      hidden: hiddenRows.some(
        (h) => (h.subject === row.subject_uri || h.subject === row.subject_did) &&
          (h.cid === "" || h.cid === cid),
      ),
    });
  }
  return result;
}

export function registerModerationRoutes(
  app: Hono,
  projectionDb: Database,
  config: ContrailConfig,
  auth?: ServiceAuthGate | null,
  db: Database = projectionDb,
): void {
  if (!config.moderation || config.moderation.reports === false) return;
  if (!auth) throw new TypeError("Reports require serviceAuth.audience");
  const ns = config.namespace;
  const authorize = async (c: Context, method: string, admin: boolean) => {
    c.header("cache-control", "no-store");
    const result = await auth.authorize(c.req.raw, method as Nsid);
    if (result.response) return { response: result.response };
    const did = result.principal?.issuer;
    if (!did || (admin && !config.moderation!.moderators.includes(did))) {
      return { response: c.json({ error: "Forbidden" }, 403) };
    }
    return { did };
  };

  app.post("/xrpc/com.atproto.moderation.createReport", async (c) => {
    const a = await authorize(c, "com.atproto.moderation.createReport", false);
    if (a.response) return a.response;
    let body: any;
    try {
      body = await smallJson(c);
    } catch {
      return c.json({ error: "InvalidRequest" }, 400);
    }
    const s = body.subject;
    let uri: string;
    let did: string | null;
    let cid: string | null = null;
    if (
      s?.$type === "com.atproto.admin.defs#repoRef" &&
      typeof s.did === "string" &&
      isDid(s.did)
    ) {
      uri = s.did;
      did = s.did;
    } else if (
      s?.$type === "com.atproto.repo.strongRef" &&
      typeof s.uri === "string" &&
      s.uri.startsWith("at://") &&
      isCid(s.cid) &&
      s.cid.length <= 256 &&
      (did = subjectDid(s.uri))
    ) {
      uri = s.uri;
      cid = s.cid;
    } else
      return c.json(
        {
          error: "InvalidRequest",
          message:
            "subject must be a repoRef or strongRef with a DID authority",
        },
        400,
      );
    if (
      !(REPORT_REASON_TYPES as readonly string[]).includes(body.reasonType) ||
      (body.reason !== undefined &&
        (typeof body.reason !== "string" || !withinReasonLimits(body.reason)))
    ) {
      return c.json({ error: "InvalidRequest" }, 400);
    }
    if (!(await isIndexedSubject(projectionDb, config, uri, did!)))
      return c.json(
        {
          error: "InvalidRequest",
          message: "subject is not indexed by this service",
        },
        400,
      );
    const now = Date.now();
    let id = 0;
    for (let attempt = 0; ; attempt++) {
      // Safe JSON integer, no clock/sequence collision across concurrent Workers.
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      id = bytes.reduce((n, b) => n * 256 + b, 0);
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO moderation_report_limits (reporter, window_start, used, last_id) VALUES (?, ?, 1, ?)
            ON CONFLICT(reporter) DO UPDATE SET
              window_start = CASE WHEN moderation_report_limits.window_start <= ? THEN excluded.window_start ELSE moderation_report_limits.window_start END,
              used = CASE WHEN moderation_report_limits.window_start <= ? THEN 1 ELSE moderation_report_limits.used + 1 END,
              last_id = excluded.last_id
            WHERE moderation_report_limits.window_start <= ? OR moderation_report_limits.used < 10`,
            )
            .bind(
              a.did,
              now,
              String(id),
              now - 3_600_000,
              now - 3_600_000,
              now - 3_600_000,
            ),
          db
            .prepare(
              `INSERT INTO moderation_reports (id, reporter, subject_uri, subject_did, subject_cid, reason_type, reason, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, CAST(? AS BIGINT) WHERE EXISTS
            (SELECT 1 FROM moderation_report_limits WHERE reporter = ? AND last_id = ?)`,
            )
            .bind(
              String(id),
              a.did,
              uri,
              did,
              cid,
              body.reasonType,
              body.reason ?? null,
              now,
              a.did,
              String(id),
            ),
        ]);
        break;
      } catch (error) {
        // A random ID collision fails the whole transaction, quota included.
        // Retry with a fresh ID; anything else is a real storage failure.
        const taken = await db
          .prepare("SELECT 1 FROM moderation_reports WHERE id = ?")
          .bind(String(id))
          .first()
          .catch(() => null);
        if (!taken || attempt >= 2) throw error;
      }
    }
    const stored = await db
      .prepare("SELECT id FROM moderation_reports WHERE id = ?")
      .bind(String(id))
      .first();
    if (!stored) {
      c.header("retry-after", "3600");
      return c.json({ error: "RateLimitExceeded" }, 429);
    }
    return c.json({
      id,
      reasonType: body.reasonType,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      // Echo the validated subject, never the caller's raw object.
      subject: cid
        ? { $type: "com.atproto.repo.strongRef", uri, cid }
        : { $type: "com.atproto.admin.defs#repoRef", did },
      reportedBy: a.did,
      createdAt: new Date(now).toISOString(),
    });
  });

  app.get(`/xrpc/${ns}.moderation.listReports`, async (c) => {
    const a = await authorize(c, `${ns}.moderation.listReports`, true);
    if (a.response) return a.response;
    const status = c.req.query("status") ?? "open";
    const limit = Number(c.req.query("limit") ?? 50);
    if (
      !["open", "resolved"].includes(status) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return c.json({ error: "InvalidRequest" }, 400);
    let cursor: [number, string] | null = null;
    if (c.req.query("cursor"))
      try {
        cursor = JSON.parse(atob(c.req.query("cursor")!));
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          !Number.isSafeInteger(cursor[0]) ||
          typeof cursor[1] !== "string" ||
          !/^\d+$/.test(cursor[1])
        )
          throw new Error();
      } catch {
        return c.json({ error: "InvalidRequest" }, 400);
      }
    const rows = await db
      .prepare(
        `SELECT * FROM moderation_reports WHERE status = ?
      ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(status, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), limit)
      .all<ReportRow>();
    const previewById = await previews(projectionDb, config, rows.results);
    const reports = rows.results.map((r) => ({
        id: Number(r.id),
        reportedBy: r.reporter,
        subject: subject(r),
        reasonType: r.reason_type,
        ...(r.reason ? { reason: r.reason } : {}),
        status: r.status,
        resolution: r.resolution,
        actionUri: r.action_uri,
        createdAt: new Date(Number(r.created_at)).toISOString(),
        resolvedAt:
          r.resolved_at === null
            ? null
            : new Date(Number(r.resolved_at)).toISOString(),
        preview: previewById.get(r.id),
      }));
    const last = rows.results.at(-1);
    return c.json({
      reports,
      ...(last && reports.length === limit
        ? { cursor: btoa(JSON.stringify([Number(last.created_at), last.id])) }
        : {}),
    });
  });

  app.post(`/xrpc/${ns}.moderation.resolveReport`, async (c) => {
    const a = await authorize(c, `${ns}.moderation.resolveReport`, true);
    if (a.response) return a.response;
    let body: any;
    try {
      body = await smallJson(c);
    } catch {
      return c.json({ error: "InvalidRequest" }, 400);
    }
    if (
      !Number.isSafeInteger(body.id) ||
      body.id < 0 ||
      (body.resolution !== undefined &&
        (typeof body.resolution !== "string" || body.resolution.length > 4000))
    )
      return c.json({ error: "InvalidRequest" }, 400);
    if (body.actionUri !== undefined) {
      try {
        const p = parseResourceUri(body.actionUri);
        if (
          p.collection !== MODERATION_ACTION_NSID ||
          !p.rkey ||
          !config.moderation!.moderators.includes(p.repo)
        )
          throw new Error();
      } catch {
        return c.json({ error: "InvalidRequest" }, 400);
      }
    }
    const exists = await db
      .prepare("SELECT id FROM moderation_reports WHERE id = ?")
      .bind(String(body.id))
      .first();
    if (!exists) return c.json({ error: "ReportNotFound" }, 404);
    await db
      .prepare(
        "UPDATE moderation_reports SET status = 'resolved', resolution = ?, action_uri = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
      )
      .bind(
        body.resolution ?? null,
        body.actionUri ?? null,
        Date.now(),
        String(body.id),
      )
      .run();
    return c.json({});
  });
}
