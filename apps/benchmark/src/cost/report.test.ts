import assert from "node:assert/strict";
import { test } from "node:test";
import type { PhaseCost } from "./meter.ts";
import { validateFixture } from "./model.ts";
import { FLAT_COST_PHASES, checkScaling, compareBaseline, createBaseline, observeScaling, projectUsage, sumCosts, type CostReport } from "./report.ts";

function phase(name: string, rowsRead = 100, rowsWritten = 0): PhaseCost {
  return { name, kind: "workload", units: 10, unit: "observation", rowsRead, rowsWritten,
    statements: 10, batches: 0, elapsedMs: 1, outcomes: {}, queries: [] };
}
function report(): CostReport {
  return {
    version: 1, measurement: "local-d1-metadata", remoteBillingCalibration: "unverified",
    contract: { fixtureVersion: 1, batchSize: 25, compatibilityDate: "2025-12-25", runtime: { wrangler: "4.84.1", miniflare: "test", workerd: "test" } },
    runs: [64, 512].map((posts) => ({
      fixture: { posts, actors: 16, operations: 10, seed: 42, preset: "full" },
      phases: FLAT_COST_PHASES.map((name) => phase(name)),
      correctness: { passed: true, assertions: 10, networkAttempts: 0 }, storage: {},
      protection: { admissionLimitsImplemented: false, openFloodAccepted: 20 },
      accountingSanity: { indexedRowsRead: 1, scanRowsRead: 32, plainInsertRowsWritten: 1, indexedInsertRowsWritten: 2 },
    })),
  };
}

test("baseline compares real row ceilings, never timing or SQL counts alone", () => {
  const current = report();
  const baseline = createBaseline(current);
  current.runs[0]!.phases[0]!.elapsedMs = 1_000_000;
  assert.deepEqual(compareBaseline(current, baseline), []);
  current.runs[0]!.phases[0]!.rowsRead = baseline.runs[0]!.phases[0]!.ceilings.rowsRead + 1;
  assert.match(compareBaseline(current, baseline).join("\n"), /rowsRead.*exceeds/);
});

test("idle zero-write baseline stays zero", () => {
  const current = report();
  const baseline = createBaseline(current);
  current.runs[0]!.phases[4]!.rowsWritten = 1;
  assert.match(compareBaseline(current, baseline).join("\n"), /rowsWritten.*ceiling 0/);
});

test("baseline fails on missing fixtures/phases, changed units and changed runtime", () => {
  for (const mutate of [
    (r: CostReport) => { r.runs.pop(); },
    (r: CostReport) => { r.runs[0]!.phases.pop(); },
    (r: CostReport) => { r.runs[0]!.phases[0]!.units++; },
    (r: CostReport) => { r.runs[0]!.fixture.seed++; },
    (r: CostReport) => { r.contract.runtime.workerd = "different"; },
  ]) {
    const current = report();
    const baseline = createBaseline(current);
    // Baseline is an artifact, not an alias of the live report.
    const saved = structuredClone(baseline);
    mutate(current);
    assert.ok(compareBaseline(current, saved).length > 0);
  }
});

test("verification overhead is neither a workload baseline nor a daily projection", () => {
  const current = report();
  const verify = { ...phase("verify.expensive", 1_000_000, 500), kind: "verification" as const };
  current.runs[0]!.phases.push(verify);
  const baseline = createBaseline(current);
  assert.equal(baseline.runs[0]!.phases.length, FLAT_COST_PHASES.length);
  assert.deepEqual(sumCosts(current.runs[0]!.phases.filter((p) => p.kind === "workload")), {
    rowsRead: 100 * FLAT_COST_PHASES.length, rowsWritten: 0, statements: 10 * FLAT_COST_PHASES.length,
  });
  assert.throws(() => projectUsage(current.runs[0]!, { "verify.expensive": 1 }, 30), /non-workload/);
});

test("unrelated-data scaling catches table scans with constant statement counts", () => {
  const current = report();
  assert.deepEqual(checkScaling(current), []);
  current.runs[1]!.phases[0]!.rowsRead = 10_000;
  assert.match(checkScaling(current).join("\n"), /Unrelated-data scaling.*ingest.update/);
  current.runs[1]!.phases[0]!.rowsRead = 100;
  current.runs[1]!.phases.push(phase("moderation.account-hide", 100_000, 100));
  assert.deepEqual(checkScaling(current), [], "account-wide jobs are explicitly data dependent");
});

test("deletion and equality-filter pages now reject corpus-sized scaling", () => {
  for (const name of ["ingest.delete", "query.filter", "query.filter-pagination", "query.filter-deep-page"]) {
    const current = report();
    current.runs[1]!.phases.find((entry) => entry.name === name)!.rowsRead = 10_000;
    assert.ok(checkScaling(current).some((failure) => failure.includes(name)), name);
  }
});

test("reports existing scan risks separately from enforced flat expectations", () => {
  const current = report();
  current.runs[0]!.phases.push(phase("query.feed", 100));
  current.runs[1]!.phases.push(phase("query.feed", 10_000));
  const observation = observeScaling(current).find((entry) => entry.phase === "query.feed")!;
  assert.equal(observation.expectation, "investigate");
  assert.equal(observation.grewMaterially, true);
  assert.deepEqual(observation.readPerUnit, [10, 1_000]);
  assert.deepEqual(checkScaling(current), []);
});

test("projection multiplies measured units/day, not phase invocations or statements", () => {
  const current = report();
  current.runs[0]!.phases[0]!.rowsWritten = 20;
  const projection = projectUsage(current.runs[0]!, { "ingest.update": 100 }, 30);
  assert.equal(projection.estimatedRowsRead, 30_000);
  assert.equal(projection.estimatedRowsWritten, 6_000);
  assert.throws(() => projectUsage(current.runs[0]!, { unknown: 1 }, 30), /Unknown/);
  assert.throws(() => projectUsage(current.runs[0]!, { "ingest.update": -1 }, 30), /Invalid/);
  assert.throws(() => projectUsage(current.runs[0]!, {}, Infinity), /days/);
});

test("fixture parameters reject ambiguous or unbounded inputs", () => {
  const valid = { posts: 64, actors: 16, operations: 8, seed: 42, preset: "full" as const };
  assert.deepEqual(validateFixture(valid), valid);
  for (const patch of [{ posts: NaN }, { posts: 1 }, { actors: 1 }, { operations: 0 }, { seed: -1 }, { seed: 0x1_0000_0000 }, { preset: "typo" }]) {
    assert.throws(() => validateFixture({ ...valid, ...patch } as typeof valid), /Invalid|Unknown/);
  }
});
