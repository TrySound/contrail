import type { Database } from "../types";
import type { FormattedRecord } from "../router/helpers";
import type { ProfileEntry } from "../router/profiles";
import { hydrateLabels } from "./hydrate";

/** Apply both record and author labels to every returned record (including
 * relation/reference previews). Never traverse user-controlled record.value. */
export async function attachRecordLabels(
  db: Database,
  records: FormattedRecord[],
  fields: string[],
  accepted: string[],
  profiles: ProfileEntry[] = [],
) {
  const all: FormattedRecord[] = [];
  const add = (record: FormattedRecord) => {
    all.push(record);
    for (const field of fields) {
      const value = record[field];
      if (!value || typeof value !== "object") continue;
      const entries = Array.isArray(value)
        ? value
        : "uri" in value
          ? [value]
          : Object.values(value).flat();
      for (const entry of entries)
        if (
          entry &&
          typeof entry.uri === "string" &&
          typeof entry.did === "string"
        )
          all.push(entry);
    }
  };
  records.forEach(add);
  const cidByUri = new Map(all.map((r) => [r.uri, r.cid]));
  for (const p of profiles) if (p.uri) cidByUri.set(p.uri, p.cid ?? null);
  const bySubject = await hydrateLabels(
    db,
    [
      ...all.flatMap((r) => [r.uri, r.did]),
      ...profiles.flatMap((p) => (p.uri ? [p.did, p.uri] : [p.did])),
    ],
    accepted,
    cidByUri,
  );
  for (const p of profiles) {
    const labels = [
      ...(bySubject[p.did] ?? []),
      ...(p.uri ? (bySubject[p.uri] ?? []) : []),
    ];
    if (labels.length) p.labels = labels;
  }
  for (const r of all) {
    const labels = [...(bySubject[r.uri] ?? []), ...(bySubject[r.did] ?? [])];
    if (labels.length) r.labels = labels;
  }
  return bySubject;
}
