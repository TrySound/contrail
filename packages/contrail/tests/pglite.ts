import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { createPostgresDatabase } from "../src/adapters/postgres";
import type { Database } from "../src/index";

/** In-process PostgreSQL for dialect coverage without a server. One PGlite
 * instance backs a minimal `pg.Pool`; a mutex serializes transactions, so
 * this checks PostgreSQL SQL semantics but not cross-connection locking. */
export function createPgliteDatabase(): Database {
  const db = new PGlite();
  let lock: Promise<void> = Promise.resolve();
  const exclusive = async () => {
    let release!: () => void;
    const prior = lock;
    lock = new Promise<void>((resolve) => (release = resolve));
    await prior;
    return release;
  };
  const run = async (text: string, values?: unknown[]) => {
    const result = await db.query(text, values as any[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = {
    async query(text: string, values?: unknown[]) {
      const release = await exclusive();
      try {
        return await run(text, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await exclusive();
      return { query: run, release };
    },
  };
  return createPostgresDatabase(pool as unknown as pg.Pool);
}
