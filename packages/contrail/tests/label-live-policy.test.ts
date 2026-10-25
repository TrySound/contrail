import { encode } from "@atcute/cbor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  applyModerationPolicy,
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  runLabelIngestCycle,
  runPersistentLabels,
  type Database,
} from "../src/index";

const src = "did:plc:external";
const did = "did:plc:test";
const label = { src, uri: did, val: "!hide", cts: "2026-01-01T00:00:00Z" };

class LabelSocket extends EventTarget {
  static instances: LabelSocket[] = [];
  binaryType = "arraybuffer";
  closed = false;
  constructor(readonly url: string) {
    super();
    LabelSocket.instances.push(this);
  }
  frame(payload: object, type = "#labels") {
    const header = encode({ op: 1, t: type });
    const body = encode(payload);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);
    this.dispatchEvent(new MessageEvent("message", { data: bytes }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}

function policy(values: string[]) {
  return resolveConfig({
    ...TEST_CONFIG,
    profiles: [],
    logger: { log() {}, warn() {}, error() {} },
    labels: { sources: [{ did: src, endpoint: "https://labels.example", enforce: true, values }] },
  });
}

async function setup() {
  LabelSocket.instances = [];
  vi.stubGlobal("WebSocket", LabelSocket);
  const db = createTestDb();
  const config = policy(["!hide"]);
  await initSchema(db, config);
  await ingestRecords(db, [makeEvent()], config);
  await db.prepare("INSERT INTO labeler_cursors (did, cursor, endpoint, resolved_at) VALUES (?, 10, ?, ?)")
    .bind(src, "https://labels.example", Date.now()).run();
  return { db, config };
}

async function socket() {
  await vi.waitFor(() => expect(LabelSocket.instances).toHaveLength(1));
  return LabelSocket.instances[0]!;
}

async function cursor(db: Database) {
  return Number((await db.prepare("SELECT cursor FROM labeler_cursors WHERE did = ?").bind(src).first<any>())?.cursor);
}

async function expectUnchanged(db: Database, config: ReturnType<typeof policy>) {
  expect(await cursor(db)).toBe(10);
  expect((await db.prepare("SELECT * FROM labels").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM moderation_hidden").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM moderation_recount_queue").all()).results).toEqual([]);
  expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(1);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("live label policy generations", () => {
  it("commits labels, visibility and the source cursor under the current policy", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(11);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("still checkpoints current filter-only frames", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [{ ...label, val: "spam" }] });
    ws.close();
    await work;
    expect(await cursor(db)).toBe(11);
    expect((await db.prepare("SELECT * FROM labels").all()).results).toEqual([]);
  });

  it("rejects buffered labels and checkpoints after a completed policy restriction", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    const next = policy(["spam"]);
    await applyModerationPolicy(db, next);
    ws.close();
    await work;
    await expectUnchanged(db, next);
    await runLabelIngestCycle(db, config, 1_000);
    expect(LabelSocket.instances).toHaveLength(1);
  });

  it("guards filter-only checkpoints from an obsolete subscription too", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [] });
    await applyModerationPolicy(db, policy(["spam"]));
    ws.close();
    await work;
    expect(await cursor(db)).toBe(10);
  });

  it("checks the generation inside the write transaction, not only before SQL", async () => {
    const { db, config } = await setup();
    const next = policy(["spam"]);
    let prepared = false;
    let replaced = false;
    const racing: Database = {
      dialect: db.dialect,
      prepare(sql) {
        if (sql.startsWith("INSERT INTO labels")) prepared = true;
        return db.prepare(sql);
      },
      async batch(statements) {
        if (prepared && !replaced) {
          replaced = true;
          await applyModerationPolicy(db, next);
        }
        return db.batch(statements);
      },
    };
    const work = runLabelIngestCycle(racing, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    ws.close();
    await work;
    expect(replaced).toBe(true);
    await expectUnchanged(db, next);
  });

  it("invalidates a pre-revert socket and lets a fresh socket replay its uncommitted cursor", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    await applyModerationPolicy(db, policy(["spam"]));
    await applyModerationPolicy(db, config);
    ws.close();
    await work;
    await expectUnchanged(db, config);

    const replay = runLabelIngestCycle(db, config, 1_000);
    await vi.waitFor(() => expect(LabelSocket.instances).toHaveLength(2));
    const fresh = LabelSocket.instances[1]!;
    expect(new URL(fresh.url).searchParams.get("cursor")).toBe("10");
    fresh.frame({ seq: 11, labels: [label] });
    fresh.close();
    await replay;
    expect(await cursor(db)).toBe(11);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("closes an obsolete persistent subscription without a reconnect loop", async () => {
    const { db, config } = await setup();
    const work = runPersistentLabels(db, config, { batchSize: 1 });
    const ws = await socket();
    const next = policy(["spam"]);
    await applyModerationPolicy(db, next);
    ws.frame({ seq: 11, labels: [label] });
    await work;
    expect(ws.closed).toBe(true);
    expect(LabelSocket.instances).toHaveLength(1);
    await expectUnchanged(db, next);
  });

  it("resets the current cursor without a close-time flush restoring the old sequence", async () => {
    const { db, config } = await setup();
    const work = runLabelIngestCycle(db, config, 1_000);
    const ws = await socket();
    ws.frame({ seq: 11, labels: [label] });
    ws.frame({ name: "OutdatedCursor" }, "#info");
    await work;
    expect(await cursor(db)).toBe(0);
    expect((await queryRecords(db, config, { collection: "event" })).records).toEqual([]);
  });

  it("guards cursor resets against policy replacement during an OutdatedCursor frame", async () => {
    const { db, config } = await setup();
    let replaced = false;
    let resetPrepared = false;
    const next = policy(["spam"]);
    const racing: Database = {
      dialect: db.dialect,
      prepare(sql) {
        if (sql.includes("ON CONFLICT(did) DO UPDATE SET cursor = 0")) resetPrepared = true;
        return db.prepare(sql);
      },
      async batch(statements) {
        if (resetPrepared && !replaced) {
          replaced = true;
          await applyModerationPolicy(db, next);
        }
        return db.batch(statements);
      },
    };
    const work = runLabelIngestCycle(racing, config, 1_000);
    const ws = await socket();
    ws.frame({ name: "OutdatedCursor" }, "#info");
    await work;
    expect(replaced).toBe(true);
    await expectUnchanged(db, next);
  });
});
