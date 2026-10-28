/** Wire constants shared by the moderation server routes and the
 * `@atmo-dev/contrail/moderation` client. Keep this module dependency-free so
 * browser bundles never pull in server code. */

export const MODERATION_ACTION_NSID = "tools.atmo.moderation.action";

export const REPORT_REASON_TYPES = [
  "com.atproto.moderation.defs#reasonSpam",
  "com.atproto.moderation.defs#reasonViolation",
  "com.atproto.moderation.defs#reasonMisleading",
  "com.atproto.moderation.defs#reasonSexual",
  "com.atproto.moderation.defs#reasonRude",
  "com.atproto.moderation.defs#reasonOther",
  "com.atproto.moderation.defs#reasonAppeal",
] as const;

export type ReportReasonType = (typeof REPORT_REASON_TYPES)[number];
