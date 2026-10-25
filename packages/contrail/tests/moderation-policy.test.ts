import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  applyModerationPolicy,
  getMeta,
  ingestRecords,
  initSchema,
  MODERATION_ACTION_NSID,
  moderationPolicyFingerprint,
  queryRecords,
  resolveConfig,
  runModerationPolicyJob,
} from "../src/index";
import type { ContrailConfig, Database } from "../src/index";

const moderator = "did:plc:moderator";
const external = "did:plc:external";
const actors = ["did:plc:a1", "did:plc:a2", "did:plc:a3", "did:plc:a4", "did:plc:a5"];
const base = {
  ...TEST_CONFIG,
  collections: {
    ...TEST_CONFIG.collections,
    event: { ...TEST_CONFIG.collections.event, searchable: ["name"] },
  },
};
const trusted = resolveConfig({ ...base, moderation: { moderators: [moderator], reports: false } });
const untrusted = resolveConfig({
  ...base,
  moderation: { moderators: [], reports: false },
  labels: { sources: [{ did: external, subjects: "known" }] },
});
let db: Database;
let time = 100;

function hide(subject: string, rkey: string) {
  return makeEvent({
    uri: `at://${moderator}/${MODERATION_ACTION_NSID}/${rkey}`,
    did: moderator,
    collection: MODERATION_ACTION_NSID,
    rkey,
    record: { subject, action: "!hide", createdAt: "2026-01-01T00:00:00Z" },
    cid: `cid${time}`,
    time_us: ++time,
  });
}

async function visible(config: ContrailConfig) {
  return (await queryRecords(db, config, { collection: "event" })).records.length;
}

beforeEach(async () => {
  db = createTestDb();
  time = 100;
  await initSchema(db, trusted);
  await ingestRecords(
    db,
    actors.map((did) =>
      makeEvent({
        uri: `at://${did}/community.lexicon.calendar.event/e`,
        did,
        record: { name: "party" },
        time_us: ++time,
      }),
    ),
    trusted,
  );
  for (const did of actors)
    await db.prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)").bind(did).run();
  await ingestRecords(db, actors.map((did, i) => hide(did, `h${i}`)), trusted);
  expect(await visible(trusted)).toBe(0);
});

describe("moderation policy changes", () => {
  it("never rerun DDL or rebuild FTS", async () => {
    const statements: string[] = [];
    const recording: Database = {
      ...db,
      prepare: (sql) => {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: (stmts) => db.batch(stmts),
      dialect: db.dialect,
    };
    await initSchema(recording, untrusted);
    expect(statements.filter((s) => /\bCREATE\b|fts_/i.test(s))).toEqual([]);
    expect(await visible(untrusted)).toBe(actors.length);
    expect(await getMeta(db, "moderation_policy_applied")).toBe(
      moderationPolicyFingerprint(untrusted),
    );
  });

  it("apply in bounded, resumable pages", async () => {
    await applyModerationPolicy(db, untrusted, { maxPages: 1, pageSize: 2 });
    // Trust is rewritten immediately; materialized state catches up in pages.
    expect(
      await db.prepare("SELECT 1 FROM moderation_sources WHERE did = ?").bind(moderator).first(),
    ).toBeNull();
    expect(await visible(untrusted)).toBeLessThan(actors.length);
    let runs = 0;
    while (await runModerationPolicyJob(db, untrusted, { maxPages: 1, pageSize: 2 })) runs++;
    expect(runs).toBeGreaterThan(3);
    expect(await visible(untrusted)).toBe(actors.length);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM label_backfill_queue WHERE src = ? AND completed = 0")
        .bind(external)
        .first<{ n: number }>())!.n,
    ).toBe(actors.length);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
    expect(await getMeta(db, "moderation_policy_applied")).toBe(
      moderationPolicyFingerprint(untrusted),
    );
  });

  it("a reverted policy replaces an unfinished job", async () => {
    await applyModerationPolicy(db, untrusted, { maxPages: 0 });
    await applyModerationPolicy(db, trusted);
    // The superseded job is never advanced under the old config.
    expect(await runModerationPolicyJob(db, untrusted)).toBe(0);
    expect(
      await db.prepare("SELECT 1 FROM moderation_sources WHERE did = ?").bind(moderator).first(),
    ).not.toBeNull();
    expect(await visible(trusted)).toBe(0);
    expect(await getMeta(db, "moderation_policy_job")).toBeNull();
  });
});
