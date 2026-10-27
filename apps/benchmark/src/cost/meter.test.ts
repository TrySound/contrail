import assert from "node:assert/strict";
import { test } from "node:test";
import type { Database, Statement } from "@atmo-dev/contrail";
import { createCostMeter } from "./meter.ts";

function fakeD1(meta: unknown = { rows_read: 1_000, rows_written: 7 }, rows: unknown[] = [{ id: 1 }]) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const rawStatements = new WeakSet<Statement>();
  function prepare(sql: string, args: unknown[] = []): Statement {
    const execute = async () => { calls.push({ sql, args }); return { results: rows, meta }; };
    const statement: Statement = {
      bind: (...values) => prepare(sql, values),
      run: execute,
      all: async <T>() => await execute() as { results: T[] },
      first: async () => { throw new Error("Metadata-discarding raw first() must not be called"); },
    };
    rawStatements.add(statement);
    return statement;
  }
  const db: Database = {
    prepare,
    async batch(statements) {
      assert.ok(statements.every((statement) => rawStatements.has(statement)), "batch must unwrap statements");
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { db, calls };
}

test("counts D1 visited/written rows, not returned rows, and preserves bind/results", async () => {
  const raw = fakeD1();
  const meter = createCostMeter(raw.db);
  await meter.measure("read", "workload", 3, "request", async () => {
    assert.deepEqual(await meter.db.prepare("SELECT * FROM items WHERE id = ?").bind(1).first(), { id: 1 });
    assert.deepEqual((await meter.db.prepare("SELECT * FROM items").all()).results, [{ id: 1 }]);
    await meter.db.prepare("UPDATE items SET x = ?").bind("x").run();
  });
  assert.equal(raw.calls.length, 3);
  assert.deepEqual(raw.calls[0]!.args, [1]);
  assert.equal(meter.phases[0]!.rowsRead, 3_000);
  assert.equal(meter.phases[0]!.rowsWritten, 21);
  assert.equal(meter.phases[0]!.statements, 3);
});

test("batch members are counted once and SQL templates are aggregated", async () => {
  const raw = fakeD1({ rows_read: 12, rows_written: 4 });
  const meter = createCostMeter(raw.db);
  await meter.measure("batch", "setup", 2, "record", async () => {
    await meter.db.batch([meter.db.prepare("INSERT INTO items VALUES (?)").bind(1), meter.db.prepare("INSERT INTO items VALUES (?)").bind(2)]);
    meter.note("accepted", 1);
    meter.note("accepted", 1);
  });
  const phase = meter.phases[0]!;
  assert.equal(raw.calls.length, 2);
  assert.equal(phase.rowsRead, 24);
  assert.equal(phase.rowsWritten, 8);
  assert.equal(phase.batches, 1);
  assert.equal(phase.queries.length, 1);
  assert.equal(phase.queries[0]!.statements, 2);
  assert.equal(phase.outcomes.accepted, 2);
});

test("first() preserves null for empty results", async () => {
  const meter = createCostMeter(fakeD1({ rows_read: 0, rows_written: 0 }, []).db);
  await meter.measure("empty", "workload", 1, "request", async () => {
    assert.equal(await meter.db.prepare("SELECT 1 WHERE 0").first(), null);
  });
  assert.equal(meter.phases[0]!.rowsRead, 0);
});

for (const meta of [undefined, {}, { rows_read: 1 }, { rows_read: "4", rows_written: 0 }, { rows_read: -1, rows_written: 0 }, { rows_read: NaN, rows_written: 0 }, { rows_read: 0, rows_written: 0.5 }]) {
  test(`fails closed on missing/invalid accounting: ${JSON.stringify(meta)}`, async () => {
    const raw = fakeD1(meta ?? null);
    const meter = createCostMeter(raw.db);
    await assert.rejects(meter.measure("invalid", "workload", 1, "request", () => meter.db.prepare("SELECT 1").all()), /D1 row accounting/);
  });
}

test("requires phases before executing SQL and rejects unmetered batch members", async () => {
  const raw = fakeD1();
  const meter = createCostMeter(raw.db);
  await assert.rejects(meter.db.prepare("SELECT 1").run(), /outside/);
  assert.equal(raw.calls.length, 0);
  await meter.measure("phase", "workload", 1, "request", async () => {
    await assert.rejects(meter.db.batch([raw.db.prepare("SELECT 1")]), /Uninstrumented/);
    await assert.rejects(meter.measure("nested", "setup", 1, "request", async () => {}), /nested/);
  });
  await assert.rejects(meter.measure("phase", "workload", 1, "request", async () => {}), /Duplicate/);
  await assert.rejects(meter.measure("zero", "workload", 0, "request", async () => {}), /units/);
});

test("rejects truncated batch metadata rather than treating missing results as zero", async () => {
  const raw = fakeD1();
  raw.db.batch = async () => [];
  const meter = createCostMeter(raw.db);
  await assert.rejects(meter.measure("truncated", "workload", 1, "request", () => meter.db.batch([meter.db.prepare("SELECT 1")])), /Incomplete/);
});
