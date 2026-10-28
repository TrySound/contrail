import { describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import { ingestRecords, initSchema, MODERATION_ACTION_NSID, resolveConfig, visibleRecordSql } from "../src/index";
import { createPostgresDatabase } from "../src/adapters/postgres";
import { getDialect } from "../src/core/dialect";
import type { Database } from "../src/index";
import { childRecountStatements } from "../src/core/db/records";

const parent = "at://did:plc:p/community.lexicon.calendar.event/e";
const going = "community.lexicon.calendar.rsvp#going";
const distinctConfig = resolveConfig({
  ...TEST_CONFIG,
  collections: {
    ...TEST_CONFIG.collections,
    event: {
      ...TEST_CONFIG.collections.event,
      relations: {
        rsvps: { ...TEST_CONFIG.collections.event.relations!.rsvps, countDistinct: "did" },
      },
    },
  },
});

async function setup(config: typeof TEST_CONFIG, children: number): Promise<Database> {
  const db = createTestDb();
  await initSchema(db, config);
  await db
    .prepare("INSERT INTO records_event (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, 'did:plc:p', 'e', 'c', '{}', 1, 1)")
    .bind(parent)
    .run();
  for (let i = 0; i < children; i++)
    await db
      .prepare("INSERT INTO records_rsvp (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(
        `at://did:plc:u${i % 8}/community.lexicon.calendar.rsvp/r${i}`,
        `did:plc:u${i % 8}`,
        `r${i}`,
        `c${i}`,
        JSON.stringify({ subject: { uri: parent }, status: i % 2 ? going : "community.lexicon.calendar.rsvp#interested" }),
        i,
        i,
      )
      .run();
  return db;
}

async function hide(db: Database, rows: Array<[string, string, number | null]>) {
  for (const [subject, cid, exp] of rows)
    await db
      .prepare("INSERT INTO moderation_hidden (subject, kind, cid, exp) VALUES (?, 'label', ?, ?)")
      .bind(subject, cid, exp)
      .run();
}

/** Reference count: per-child visibility, the definition stored counts follow. */
async function expected(db: Database, distinct: boolean, status?: string) {
  const field = (path: string) => getDialect(db).jsonExtract("mc.record", path);
  const row = await db
    .prepare(
      `SELECT ${distinct ? "COUNT(DISTINCT did)" : "COUNT(*)"} AS n FROM records_rsvp mc
      WHERE ${field("subject.uri")} = ?
      ${status ? `AND ${field("status")} = ?` : ""} AND ${visibleRecordSql("mc")}`,
    )
    .bind(parent, ...(status ? [status] : []))
    .first<{ n: number }>();
  return row!.n;
}

async function recount(db: Database, config: typeof TEST_CONFIG) {
  await db.batch(childRecountStatements(db, config, "rsvp", [{ record: { subject: { uri: parent } } }]));
  return db
    .prepare("SELECT count_rsvp AS total, count_rsvp_going AS going FROM records_event WHERE uri = ?")
    .bind(parent)
    .first<{ total: number; going: number }>();
}

const hidden: Array<[string, string, number | null]> = [
  ["did:plc:u1", "", null], // account
  ["at://did:plc:u2/community.lexicon.calendar.rsvp/r2", "c2", null], // matching CID pin
  ["at://did:plc:u3/community.lexicon.calendar.rsvp/r3", "other", null], // other version
  ["at://did:plc:u4/community.lexicon.calendar.rsvp/r4", "", 1], // expired
  ["at://did:plc:u1/community.lexicon.calendar.rsvp/r9", "", null], // also hidden by account
];

describe("visible relation counts", () => {
  for (const [name, children] of [
    ["subtracts hidden children when children outnumber hidden rows", 40],
    ["probes each child when hidden rows outnumber children", 4],
  ] as const)
    it(name, async () => {
      const db = await setup(TEST_CONFIG, children);
      expect(await recount(db, TEST_CONFIG)).toEqual({ total: children, going: children / 2 });
      await hide(db, hidden);
      const counts = await recount(db, TEST_CONFIG);
      expect(counts!.total).toBe(await expected(db, false));
      expect(counts!.going).toBe(await expected(db, false, going));
      expect(counts!.total).toBeLessThan(children);
    });

  it("excludes hidden children from distinct counts", async () => {
    const db = await setup(distinctConfig, 40);
    expect((await recount(db, distinctConfig))!.total).toBe(8);
    await hide(db, hidden);
    const counts = await recount(db, distinctConfig);
    expect(counts!.total).toBe(await expected(db, true));
    expect(counts!.going).toBe(await expected(db, true, going));
    expect(counts!.total).toBe(7);
  });
});

it("orders PostgreSQL count updates before the moderation lock in mixed batches", async () => {
  const sql: string[] = [];
  const query = async (text: string) => (sql.push(text), { rows: [], rowCount: 1 });
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
  const moderator = "did:plc:moderator";
  const config = resolveConfig({ ...TEST_CONFIG, moderation: { moderators: [moderator], reports: false } });
  await ingestRecords(createPostgresDatabase(pool), [
    makeEvent({
      uri: "at://did:plc:u/community.lexicon.calendar.rsvp/r",
      did: "did:plc:u",
      collection: "community.lexicon.calendar.rsvp",
      rkey: "r",
      record: { subject: { uri: parent }, status: going },
    }),
    makeEvent({
      uri: `at://${moderator}/${MODERATION_ACTION_NSID}/a`,
      did: moderator,
      collection: MODERATION_ACTION_NSID,
      rkey: "a",
      record: { subject: "did:plc:x", action: "!hide", createdAt: new Date().toISOString() },
    }),
  ], config);
  const count = sql.findIndex((s) => s.startsWith("UPDATE records_event SET count_rsvp"));
  const lock = sql.findIndex((s) => s.includes("pg_advisory_xact_lock"));
  expect(count).toBeGreaterThan(-1);
  expect(lock).toBeGreaterThan(count);
});
