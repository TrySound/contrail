import type { Database, Statement } from "@atmo-dev/contrail";

export interface RowCost {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
}
export type PhaseKind = "setup" | "workload" | "verification";
export interface QueryCost extends RowCost { sql: string }
export interface PhaseCost extends RowCost {
  name: string;
  kind: PhaseKind;
  units: number;
  unit: string;
  batches: number;
  elapsedMs: number;
  /** Last D1 size_after metadata, not a storage billing estimate. */
  databaseBytesAfter?: number;
  outcomes: Record<string, number>;
  queries: QueryCost[];
}

export function zeroCost(): RowCost {
  return { rowsRead: 0, rowsWritten: 0, statements: 0 };
}

/** D1-compatible instrumentation, deliberately restricted to Contrail's Database API.
 * first() goes through all(): D1's first() discards the metadata we need. This
 * still executes the original SQL exactly once (no EXPLAIN or COUNT estimates).
 */
export function createCostMeter(raw: Database) {
  const phases: PhaseCost[] = [];
  const prepared = new WeakMap<Statement, { raw: Statement; sql: string }>();
  let active: PhaseCost | undefined;
  let queries = new Map<string, QueryCost>();

  function record(sql: string, result: unknown) {
    if (!active) throw new Error("SQL executed outside a measured phase");
    const meta = (result as { meta?: Record<string, unknown> })?.meta;
    const read = meta?.rows_read;
    const written = meta?.rows_written;
    if (!Number.isSafeInteger(read) || (read as number) < 0 ||
        !Number.isSafeInteger(written) || (written as number) < 0) {
      throw new Error(`Missing/invalid D1 row accounting for: ${sql.slice(0, 160)}`);
    }
    if (typeof meta?.size_after === "number") active.databaseBytesAfter = meta.size_after;
    // Clock literals change across releases; binds are never stored in reports.
    const normalized = sql.replace(/\s+/g, " ").replace(/\b\d{10,16}\b/g, "<clock>").trim();
    let query = queries.get(normalized);
    if (!query) {
      query = { sql: normalized, ...zeroCost() };
      queries.set(normalized, query);
    }
    for (const target of [active, query]) {
      target.rowsRead += read as number;
      target.rowsWritten += written as number;
      target.statements++;
    }
  }

  function wrap(statement: Statement, sql: string): Statement {
    const wrapped: Statement = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      async run() {
        if (!active) throw new Error("SQL executed outside a measured phase");
        const result = await statement.run();
        record(sql, result);
        return result;
      },
      async all<T>() {
        if (!active) throw new Error("SQL executed outside a measured phase");
        const result = await statement.all<T>();
        record(sql, result);
        return result;
      },
      async first<T>() {
        const result = await wrapped.all<T>();
        return result.results[0] ?? null;
      },
    };
    prepared.set(wrapped, { raw: statement, sql });
    return wrapped;
  }

  const db: Database = {
    ...(raw.dialect ? { dialect: raw.dialect } : {}),
    prepare: (sql) => wrap(raw.prepare(sql), sql),
    async batch(statements) {
      if (!active) throw new Error("SQL batch executed outside a measured phase");
      const entries = statements.map((statement) => {
        const entry = prepared.get(statement);
        if (!entry) throw new Error("Uninstrumented statement passed to measured batch");
        return entry;
      });
      const results = await raw.batch(entries.map((entry) => entry.raw));
      if (results.length !== entries.length) throw new Error("Incomplete D1 batch accounting");
      active.batches++;
      results.forEach((result, i) => record(entries[i]!.sql, result));
      return results;
    },
  };

  return {
    db,
    phases,
    note(key: string, value: number) {
      if (!active) throw new Error("Outcome outside a measured phase");
      active.outcomes[key] = (active.outcomes[key] ?? 0) + value;
    },
    async measure<T>(
      name: string, kind: PhaseKind, units: number, unit: string, fn: () => Promise<T>,
    ): Promise<T> {
      if (active || phases.some((phase) => phase.name === name)) throw new Error(`Duplicate/nested phase: ${name}`);
      if (!Number.isSafeInteger(units) || units <= 0) throw new Error(`Invalid units: ${name}`);
      const phase: PhaseCost = {
        name, kind, units, unit, ...zeroCost(), batches: 0, elapsedMs: 0, outcomes: {}, queries: [],
      };
      active = phase;
      queries = new Map();
      const start = performance.now();
      try {
        return await fn();
      } finally {
        phase.elapsedMs = Math.round((performance.now() - start) * 100) / 100;
        phase.queries = [...queries.values()].sort((a, b) =>
          (b.rowsRead + b.rowsWritten) - (a.rowsRead + a.rowsWritten) || a.sql.localeCompare(b.sql));
        phases.push(phase);
        active = undefined;
      }
    },
  };
}
