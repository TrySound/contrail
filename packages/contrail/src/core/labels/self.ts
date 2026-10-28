/** Author declarations are record metadata, not timestamped labeler claims. */
export interface SelfLabel {
  val: string;
}

const encoder = new TextEncoder();

/** Read only the standard root container. No database access or enforcement.
 * The returned values belong to this record version; its envelope supplies
 * the author/URI/CID. Never trust provenance fields supplied in a declaration. */
export function extractSelfLabels(value: unknown): SelfLabel[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const labels = (value as Record<string, unknown>).labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return [];
  const container = labels as Record<string, unknown>;
  if (
    container.$type !== "com.atproto.label.defs#selfLabels" ||
    !Array.isArray(container.values) ||
    container.values.length > 10
  )
    return [];

  const seen = new Set<string>();
  const result: SelfLabel[] = [];
  for (const item of container.values) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const val = (item as Record<string, unknown>).val;
    // Lexicon maxLength measures UTF-8 bytes, not JS code units/graphemes.
    // Reject huge strings before encoding so malformed metadata costs bounded work.
    if (
      typeof val !== "string" ||
      !val.length ||
      val.length > 128 ||
      encoder.encode(val).length > 128 ||
      seen.has(val)
    )
      continue;
    seen.add(val);
    result.push({ val });
  }
  return result;
}
