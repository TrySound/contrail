import type { Database } from "@atmo-dev/contrail";

function meta(result: unknown): { rows_read: number; rows_written: number } {
  return (result as { meta: { rows_read: number; rows_written: number } }).meta;
}

/** Sanity-check the local counter source, not equivalence with remote billing.
 * A returned-row counter would fail this: both reads return one row, but one
 * visits a whole table. An index write must also add write amplification. */
export async function calibrateAccounting(db: Database) {
  await db.prepare("CREATE TABLE cost_accounting_probe (id INTEGER PRIMARY KEY, value TEXT)").run();
  const plainInsert = await db.prepare("INSERT INTO cost_accounting_probe VALUES (0, 'value0')").run();
  await db.batch(Array.from({ length: 31 }, (_, i) =>
    db.prepare("INSERT INTO cost_accounting_probe VALUES (?, ?)").bind(i + 1, `value${i + 1}`)));
  const indexed = await db.prepare("SELECT * FROM cost_accounting_probe WHERE id = 1").all();
  const scan = await db.prepare("SELECT * FROM cost_accounting_probe WHERE value = 'value1'").all();
  await db.prepare("CREATE INDEX cost_accounting_probe_value ON cost_accounting_probe(value)").run();
  const withIndex = await db.prepare("INSERT INTO cost_accounting_probe VALUES (32, 'value32')").run();
  const result = {
    indexedRowsRead: meta(indexed).rows_read, scanRowsRead: meta(scan).rows_read,
    plainInsertRowsWritten: meta(plainInsert).rows_written, indexedInsertRowsWritten: meta(withIndex).rows_written,
  };
  if (indexed.results.length !== 1 || scan.results.length !== 1 ||
      result.scanRowsRead < 32 || result.indexedRowsRead >= result.scanRowsRead ||
      result.plainInsertRowsWritten < 1 || result.indexedInsertRowsWritten <= result.plainInsertRowsWritten) {
    throw new Error(`Local D1 row accounting failed its sanity check: ${JSON.stringify(result)}`);
  }
  await db.prepare("DROP TABLE cost_accounting_probe").run();
  return result;
}
