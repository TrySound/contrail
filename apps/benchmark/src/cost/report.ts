import type { PhaseCost, RowCost } from "./meter.ts";
import type { FixtureOptions } from "./model.ts";

export interface RunResult {
  fixture: FixtureOptions;
  phases: PhaseCost[];
  correctness: { passed: true; assertions: number; networkAttempts: number };
  storage: Record<string, Record<string, number>>;
  protection: { admissionLimitsImplemented: boolean; openFloodAccepted: number };
  accountingSanity: { indexedRowsRead: number; scanRowsRead: number; plainInsertRowsWritten: number; indexedInsertRowsWritten: number };
}
export interface Contract {
  fixtureVersion: number;
  batchSize: number;
  compatibilityDate: string;
  runtime: { wrangler: string; miniflare: string; workerd: string };
}
export interface CostReport {
  version: 1;
  measurement: "local-d1-metadata";
  remoteBillingCalibration: "unverified";
  contract: Contract;
  runs: RunResult[];
  scaling?: ScalingObservation[];
}
export interface Baseline {
  version: 1;
  contract: Contract;
  runs: Array<{
    fixture: FixtureOptions;
    phases: Array<{ name: string; kind: string; units: number; unit: string; ceilings: RowCost }>;
  }>;
}

export const FLAT_COST_PHASES = [
  "ingest.update", "ingest.exact-replay", "ingest.stale-replay", "maintenance.schema-check",
  "maintenance.moderation-idle", "ingest.unchanged", "ingest.delete", "query.filter",
  "query.filter-pagination", "query.filter-deep-page",
];

function key(fixture: FixtureOptions) {
  return [fixture.preset, fixture.posts, fixture.actors, fixture.operations, fixture.seed].join(":");
}
function contractKey(contract: Contract) {
  return [contract.fixtureVersion, contract.batchSize, contract.compatibilityDate,
    contract.runtime.wrangler, contract.runtime.miniflare, contract.runtime.workerd].join(":");
}

export function sumCosts(phases: PhaseCost[]): RowCost {
  return phases.reduce((sum, phase) => ({
    rowsRead: sum.rowsRead + phase.rowsRead, rowsWritten: sum.rowsWritten + phase.rowsWritten,
    statements: sum.statements + phase.statements,
  }), { rowsRead: 0, rowsWritten: 0, statements: 0 });
}

/** Explicit reviewed ceilings, not a moving baseline learned during CI. Zero
 * writes stay zero. Timings, timestamps and SQL formatting never gate costs. */
export function createBaseline(report: CostReport): Baseline {
  return {
    version: 1, contract: structuredClone(report.contract),
    runs: report.runs.map((run) => ({
      fixture: { ...run.fixture },
      phases: run.phases.filter((phase) => phase.kind !== "verification").map((phase) => ({
        name: phase.name, kind: phase.kind, units: phase.units, unit: phase.unit,
        ceilings: {
          rowsRead: phase.rowsRead === 0 ? 0 : Math.ceil(phase.rowsRead * 1.1) + 32,
          rowsWritten: phase.rowsWritten === 0 ? 0 : Math.ceil(phase.rowsWritten * 1.1) + 8,
          statements: Math.ceil(phase.statements * 1.1) + 2,
        },
      })),
    })),
  };
}

export function compareBaseline(report: CostReport, baseline: Baseline): string[] {
  const failures: string[] = [];
  if (baseline.version !== 1 || contractKey(report.contract) !== contractKey(baseline.contract)) {
    return ["Baseline contract/runtime differs; review and explicitly regenerate it"];
  }
  if (new Set(baseline.runs.map((run) => key(run.fixture))).size !== baseline.runs.length) failures.push("Duplicate baseline fixture");
  if (report.runs.length !== baseline.runs.length) failures.push("Baseline fixture count differs");
  for (const run of report.runs) {
    const expected = baseline.runs.find((entry) => key(entry.fixture) === key(run.fixture));
    if (!expected) { failures.push(`Missing baseline fixture ${key(run.fixture)}`); continue; }
    const phases = run.phases.filter((phase) => phase.kind !== "verification");
    if (phases.length !== expected.phases.length) failures.push(`Phase set differs for ${key(run.fixture)}`);
    for (const phase of phases) {
      const before = expected.phases.find((entry) => entry.name === phase.name);
      if (!before || before.kind !== phase.kind || before.units !== phase.units || before.unit !== phase.unit) {
        failures.push(`Phase contract differs: ${key(run.fixture)} ${phase.name}`);
        continue;
      }
      for (const metric of ["rowsRead", "rowsWritten", "statements"] as const) {
        const ceiling = before.ceilings[metric];
        if (!Number.isSafeInteger(ceiling) || ceiling < 0 || phase[metric] > ceiling) {
          failures.push(`${key(run.fixture)} ${phase.name} ${metric}: ${phase[metric]} exceeds ceiling ${ceiling}`);
        }
      }
    }
  }
  return failures;
}

/** Only unrelated-data operations have a flat scaling expectation. Hot-parent
 * recounts, account-wide moderation, search and policy scans intentionally do not. */
export function checkScaling(report: CostReport): string[] {
  const failures: string[] = [];
  const groups = new Map<string, RunResult[]>();
  for (const run of report.runs) {
    const group = [run.fixture.preset, run.fixture.actors, run.fixture.operations, run.fixture.seed].join(":");
    groups.set(group, [...(groups.get(group) ?? []), run]);
  }
  for (const runs of groups.values()) {
    runs.sort((a, b) => a.fixture.posts - b.fixture.posts);
    if (runs.length < 2) continue;
    const small = runs[0]!;
    for (const large of runs.slice(1)) for (const name of FLAT_COST_PHASES) {
      const before = small.phases.find((phase) => phase.name === name);
      const after = large.phases.find((phase) => phase.name === name);
      if (!before || !after) { failures.push(`Missing scaling phase ${name}`); continue; }
      for (const metric of ["rowsRead", "rowsWritten"] as const) {
        const low = before[metric] / before.units;
        const high = after[metric] / after.units;
        const ceiling = metric === "rowsWritten" && low === 0 ? 0 : low * 3 + 16;
        if (high > ceiling) failures.push(`Unrelated-data scaling: ${name} ${metric}/unit ${low.toFixed(2)} → ${high.toFixed(2)} (${small.fixture.posts} → ${large.fixture.posts} posts), ceiling ${ceiling.toFixed(2)}`);
      }
    }
  }
  return failures;
}

export interface ScalingObservation {
  preset: string;
  phase: string;
  smallPosts: number;
  largePosts: number;
  readPerUnit: [number, number];
  writtenPerUnit: [number, number];
  expectation: "flat" | "investigate" | "data-dependent";
  grewMaterially: boolean;
}

/** Keep pre-existing scan risks visible even when their current costs fit the
 * reviewed baseline. Account jobs and hot-parent recounts have different,
 * explicitly data-dependent semantics and must not be advertised as flat. */
export function observeScaling(report: CostReport): ScalingObservation[] {
  const observations: ScalingObservation[] = [];
  const candidates = ["query.feed", "maintenance.feed-sweep"];
  for (const small of report.runs) {
    const matches = report.runs.filter((run) => run.fixture.posts > small.fixture.posts &&
      run.fixture.preset === small.fixture.preset && run.fixture.actors === small.fixture.actors &&
      run.fixture.operations === small.fixture.operations && run.fixture.seed === small.fixture.seed);
    for (const large of matches) for (const before of small.phases.filter((phase) => phase.kind === "workload")) {
      const after = large.phases.find((phase) => phase.name === before.name);
      if (!after) continue;
      const read: [number, number] = [before.rowsRead / before.units, after.rowsRead / after.units];
      const written: [number, number] = [before.rowsWritten / before.units, after.rowsWritten / after.units];
      observations.push({
        preset: small.fixture.preset, phase: before.name, smallPosts: small.fixture.posts, largePosts: large.fixture.posts,
        readPerUnit: read, writtenPerUnit: written,
        expectation: FLAT_COST_PHASES.includes(before.name) ? "flat" : candidates.includes(before.name) ? "investigate" : "data-dependent",
        grewMaterially: read[1] > read[0] * 3 + 16 || written[1] > written[0] * 3 + 16,
      });
    }
  }
  return observations;
}

/** Scenario-specific estimates: inputs are measured phase UNITS/day, not SQL
 * statements/day. Setup and verification must not accidentally recur daily. */
export function projectUsage(run: RunResult, dailyUnits: Record<string, number>, days: number) {
  if (!Number.isFinite(days) || days <= 0) throw new Error("Projection days must be positive");
  let rowsRead = 0;
  let rowsWritten = 0;
  for (const [name, units] of Object.entries(dailyUnits)) {
    const phase = run.phases.find((entry) => entry.name === name && entry.kind === "workload");
    if (!phase) throw new Error(`Unknown/non-workload projection phase: ${name}`);
    if (!Number.isFinite(units) || units < 0) throw new Error(`Invalid daily units: ${name}`);
    rowsRead += phase.rowsRead / phase.units * units * days;
    rowsWritten += phase.rowsWritten / phase.units * units * days;
  }
  return { days, dailyUnits, estimatedRowsRead: Math.ceil(rowsRead), estimatedRowsWritten: Math.ceil(rowsWritten) };
}
