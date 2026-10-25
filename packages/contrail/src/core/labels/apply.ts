import type { ContrailConfig, Database, Statement } from "../types";
import type { LabelerSource } from "./types";
import {
  HIDE_LABEL_VALUES,
  moderationLockStatements,
  recomputeModerationStatements,
  subjectDid,
  type ModerationWriteGuard,
} from "../moderation";
import { batchedInQuery } from "../router/helpers";

/** Wire shape of a single `com.atproto.label.defs#label` entry. Field names
 *  match the spec exactly. We accept the spec's ISO-8601 strings and
 *  convert to unix seconds at the storage boundary. */
export interface IncomingLabel {
  src: string;
  uri: string;
  val: string;
  cid?: string;
  neg?: boolean;
  exp?: string;
  cts: string;
  sig?: Uint8Array | string | { $bytes: string };
}

/** Clock-skew allowance for label `cts`; anything later is rejected. */
const MAX_CTS_SKEW_SEC = 5 * 60;

/** Upsert a batch of labels. Idempotent on `(src, uri, val, cts)`. Bad rows
 *  (missing required fields, unparseable or forward-dated timestamps) are
 *  dropped silently; we don't want one malformed label to abort an entire
 *  labeler frame. */
export async function applyLabels(
  db: Database,
  labels: IncomingLabel[],
  options: {
    source?: LabelerSource;
    /** Locks acquired before any guarded writes (never held over network I/O). */
    leadingStatements?: Statement[];
    /** Guard label writes and dirty marks. Trailing checkpoints must use the
     * same predicate so labels and progress are accepted or rejected together. */
    writeGuard?: ModerationWriteGuard;
    trailingStatements?: Statement[];
    knownDids?: ReadonlySet<string>;
    /** Enables relation recounts when enforcement changes. */
    config?: ContrailConfig;
  } = {},
): Promise<number> {
  // Lock before label rows, matching guarded backfill commits. Taking this
  // only during the later recompute can deadlock a live labeler against a
  // backfill holding the moderation lock while updating the same label tuple.
  const stmts: Statement[] = [
    ...(options.leadingStatements ?? []),
    ...moderationLockStatements(db),
  ];
  const guard = options.writeGuard;
  const valid = labels.filter(
    (l) =>
      l &&
      typeof l.src === "string" &&
      typeof l.uri === "string" &&
      typeof l.val === "string" &&
      typeof l.cts === "string" &&
      l.src &&
      l.val &&
      l.cts &&
      subjectDid(l.uri) &&
      l.val.length <= 128 &&
      (l.exp === undefined || typeof l.exp === "string") &&
      (l.cid === undefined || typeof l.cid === "string") &&
      (l.neg === undefined || typeof l.neg === "boolean") &&
      (!options.source ||
        (l.src === options.source.did && !options.source.records)),
  );
  const known = new Set(options.knownDids);
  const retractions = new Set<string>();
  const source = options.source;
  if (source) {
    const negativeUris = [
      ...new Set(valid.filter((l) => l.neg).map((l) => l.uri)),
    ];
    const stored = await batchedInQuery<{ uri: string; val: string }>(
      db,
      "SELECT DISTINCT uri, val FROM labels WHERE src = ? AND uri IN (__IN__)",
      [source.did],
      negativeUris,
    );
    for (const row of stored) retractions.add(`${row.uri}\0${row.val}`);
    if (source.subjects === "known") {
      const dids = [
        ...new Set(
          valid
            .filter((l) => !source.values || source.values.includes(l.val))
            .map((l) => subjectDid(l.uri)!),
        ),
      ].filter((did) => !known.has(did));
      const rows = await batchedInQuery<{ did: string }>(
        db,
        "SELECT did FROM identities WHERE did IN (__IN__)",
        [],
        dids,
      );
      for (const row of rows) known.add(row.did);
    }
  }
  let kept = 0;
  const hideSubjects = new Set<string>();
  const maxCts = Math.floor(Date.now() / 1000) + MAX_CTS_SKEW_SEC;
  for (const l of valid) {
    if (source && !(l.neg && retractions.has(`${l.uri}\0${l.val}`))) {
      if (source.values && !source.values.includes(l.val)) continue;
      if (source.subjects === "known" && !known.has(subjectDid(l.uri)!))
        continue;
    }
    const cts = isoToUnixSec(l.cts);
    // Overrides only suppress labels created before them, so a forward-dated
    // cts would make a label immune to moderator overrides.
    if (cts == null || cts > maxCts) continue;
    const exp = l.exp ? isoToUnixSec(l.exp) : null;
    if (l.exp !== undefined && exp === null) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO labels (src, uri, val, cid, neg, exp, cts, sig)
             ${guard ? "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE " + guard.sql : "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"}
             ON CONFLICT(src, uri, val, cts) DO UPDATE SET
               cid = excluded.cid,
               neg = excluded.neg,
               exp = excluded.exp,
               sig = excluded.sig`,
        )
        .bind(
          l.src,
          l.uri,
          l.val,
          l.cid ?? null,
          l.neg ? 1 : 0,
          exp,
          cts,
          decodeSignature(l.sig),
          ...(guard?.bindings ?? []),
        ),
    );
    kept++;
    if ((HIDE_LABEL_VALUES as readonly string[]).includes(l.val))
      hideSubjects.add(l.uri);
  }
  stmts.push(
    ...recomputeModerationStatements(db, options.config, hideSubjects, guard),
    ...(options.trailingStatements ?? []),
  );
  if (stmts.length > 0) await db.batch(stmts);
  return kept;
}

function decodeSignature(sig: IncomingLabel["sig"]): Uint8Array | null {
  if (sig instanceof Uint8Array) return sig;
  const encoded =
    typeof sig === "string"
      ? sig
      : sig && typeof sig.$bytes === "string"
        ? sig.$bytes
        : null;
  if (!encoded || encoded.length > 4096) return null;
  try {
    return Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function isoToUnixSec(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
