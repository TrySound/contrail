import type { Database } from "../types";
import { batchedInQuery } from "../router/helpers";

/** Wire-shape for a hydrated label — matches `com.atproto.label.defs#label`
 *  field-for-field so consumers can pass it straight through to atproto SDKs. */
export interface HydratedLabel {
  src: string;
  uri: string;
  val: string;
  cid?: string;
  /** Only present when true. */
  neg?: true;
  /** ISO-8601, omitted when no expiry is set. */
  exp?: string;
  /** ISO-8601 creation timestamp. */
  cts: string;
}

interface RawLabelRow {
  src: string;
  uri: string;
  val: string;
  cid: string | null;
  neg: number;
  exp: number | null;
  cts: number;
}

/** Fetch effective labels and independent moderator actions, filter to the
 *  caller's accepted labelers and record versions, then choose one applicable
 *  label per `(src, uri, val)` for presentation. External label retractions and
 *  supersession are resolved by the SQL view before expiry/CID filtering.
 *  Subjects can be at-URIs or bare DIDs. */
export async function hydrateLabels(
  db: Database,
  subjects: string[],
  accepted: string[],
  recordCidByUri?: Map<string, string | null>,
): Promise<Record<string, HydratedLabel[]>> {
  if (subjects.length === 0 || accepted.length === 0) return {};

  // Dedupe subjects — the same DID may appear in `dids` and as the at-URI
  // author; the same at-URI may come from list + hydrate.
  const uniqSubjects = [...new Set(subjects)];
  const uniqAccepted = [...new Set(accepted)];

  const placeholders = uniqAccepted.map(() => "?").join(",");
  const nowSec = Math.floor(Date.now() / 1000);

  // Bindings via batchedInQuery are: [...prefix, ...chunk]. Put the `exp`
  // filter *before* the `__IN__` placeholder so the binding order matches
  // the SQL placeholder order.
  const rows = await batchedInQuery<RawLabelRow>(
    db,
    `SELECT src, uri, val, cid, neg, exp, cts FROM moderation_effective_labels
       WHERE src IN (${placeholders})
         AND (exp IS NULL OR exp > ?)
         AND uri IN (__IN__)`,
    [...uniqAccepted, nowSec],
    uniqSubjects,
  );

  // Filter independent actions to the returned version before collapsing:
  // a newer action for another CID must not discard an applicable older one.
  // Pick the latest row per `(src, uri, val)`. Ties on `cts` resolve by
  // taking the row that arrived later in the query results — driver-dependent
  // but rare in practice; spec doesn't define tie-breaking.
  type Key = string;
  const latestByKey = new Map<Key, RawLabelRow>();
  for (const row of rows) {
    if (row.cid && recordCidByUri) {
      const recordCid = recordCidByUri.get(row.uri);
      if (recordCid !== undefined && recordCid !== row.cid) continue;
    }
    const key = `${row.src}\u0000${row.uri}\u0000${row.val}`;
    const prior = latestByKey.get(key);
    if (!prior || row.cts >= prior.cts) latestByKey.set(key, row);
  }

  const out: Record<string, HydratedLabel[]> = {};
  for (const row of latestByKey.values()) {
    if (row.neg) continue; // retracted

    const label: HydratedLabel = {
      src: row.src,
      uri: row.uri,
      val: row.val,
      cts: new Date(row.cts).toISOString(),
    };
    if (row.cid) label.cid = row.cid;
    if (row.exp != null) label.exp = tsToIso(row.exp);
    (out[row.uri] ??= []).push(label);
  }

  return out;
}

function tsToIso(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}
