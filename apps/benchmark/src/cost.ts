import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { BATCH_SIZE, FIXTURE_VERSION, validateFixture, type FixtureOptions } from "./cost/model.ts";
import { checkScaling, compareBaseline, createBaseline, observeScaling, projectUsage, sumCosts, type Baseline, type CostReport, type RunResult } from "./cost/report.ts";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  profile: { type: "string", default: "default" }, preset: { type: "string", default: "full" },
  sizes: { type: "string" }, actors: { type: "string" }, operations: { type: "string" }, seed: { type: "string", default: "42" },
  output: { type: "string" }, baseline: { type: "string" }, "write-baseline": { type: "string" },
  projection: { type: "string" }, timeout: { type: "string", default: "300000" }, help: { type: "boolean" },
} });

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  const address = server.address();
  await new Promise<void>((closed) => server.close(() => closed()));
  if (!address || typeof address === "string") throw new Error("No local port available");
  return address.port;
}

async function runFixture(fixture: FixtureOptions, timeout: number): Promise<RunResult> {
  const state = await mkdtemp(join(tmpdir(), "contrail-d1-cost-"));
  const port = await availablePort();
  const inspectorPort = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [require.resolve("wrangler"), "dev", "--local",
    "--config", resolve(ROOT, "wrangler.cost.jsonc"), "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", String(inspectorPort),
    "--persist-to", state, "--log-level", "warn",
  ], { cwd: ROOT, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-20_000); });
  child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-20_000); });
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  try {
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Wrangler exited ${child.exitCode}`);
      try {
        ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok;
        if (ready) break;
      } catch { /* Startup is polled, not assumed from log text. */ }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!ready) throw new Error("Local cost Worker did not become ready in 45s");
    const response = await fetch(`${origin}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture),
      signal: AbortSignal.timeout(timeout),
    });
    const result = await response.json() as RunResult & { error?: string };
    if (!response.ok || result.error) throw new Error(result.error ?? `Cost Worker returned ${response.status}`);
    if (!result.correctness?.passed || result.correctness.networkAttempts !== 0) throw new Error("Incomplete/invalid correctness results");
    return result;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); done(); });
      });
    }
    await rm(state, { force: true, recursive: true });
  }
}

function version(name: string, from: string) {
  return JSON.parse(readFileSync(createRequire(from).resolve(`${name}/package.json`), "utf8")).version as string;
}

async function main() {
  if (values.help) {
    console.log(`Local-only deterministic D1 row-cost benchmark\n\nUsage: pnpm bench:cost [options]\n  --profile ci|default|heavy       Default: 1k/10k posts, 100 actors, 50 operations\n  --preset core|moderation|full|all Default: full (profiles, feeds, moderation)\n  --sizes 1000,10000 --actors 100 --operations 50 --seed 42\n  --baseline FILE                 Fail when a reviewed ceiling is exceeded\n  --write-baseline FILE           Explicitly generate reviewed ceilings\n  --output FILE                   JSON report (default: results/cost-latest.json)\n  --projection FILE               JSON { days: 30, dailyUnits: { phase: unitsPerDay } }\n  --timeout MS                    Per-fixture request timeout (default: 300000)\n\nMeasures local D1 metadata; remote billing equivalence is not yet calibrated.`);
    return;
  }
  const profiles: Record<string, { sizes: number[]; actors: number; operations: number }> = {
    ci: { sizes: [64, 512], actors: 16, operations: 8 },
    default: { sizes: [1_000, 10_000], actors: 100, operations: 50 },
    heavy: { sizes: [10_000, 100_000], actors: 1_000, operations: 100 },
  };
  const profile = profiles[values.profile!];
  if (!profile) throw new Error(`Unknown profile: ${values.profile}`);
  const sizes = values.sizes ? values.sizes.split(",").map(Number) : profile.sizes;
  if (!sizes.length || new Set(sizes).size !== sizes.length) throw new Error("Sizes must be nonempty and unique");
  const presets = values.preset === "all" ? ["core", "moderation", "full"] as const : [values.preset as FixtureOptions["preset"]];
  const fixtures = presets.flatMap((preset) => sizes.map((posts) => validateFixture({
    posts, actors: Number(values.actors ?? profile.actors), operations: Number(values.operations ?? profile.operations), seed: Number(values.seed), preset,
  })));
  const timeout = Number(values.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000) throw new Error("Timeout must be an integer >= 1000ms");
  const wranglerPath = require.resolve("wrangler");
  const wranglerRequire = createRequire(wranglerPath);
  const miniflarePath = wranglerRequire.resolve("miniflare");
  const report: CostReport & { generatedAt: string; gitCommit: string; gitDirty: boolean; nodeVersion: string; projections?: unknown[] } = {
    version: 1, generatedAt: new Date().toISOString(),
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    gitDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim()),
    nodeVersion: process.version,
    measurement: "local-d1-metadata", remoteBillingCalibration: "unverified",
    contract: {
      fixtureVersion: FIXTURE_VERSION, batchSize: BATCH_SIZE, compatibilityDate: "2025-12-25",
      runtime: { wrangler: version("wrangler", wranglerPath), miniflare: version("miniflare", wranglerPath), workerd: version("workerd", miniflarePath) },
    }, runs: [],
  };
  for (const fixture of fixtures) {
    console.log(`\n${fixture.preset}: ${fixture.posts.toLocaleString()} posts, ${fixture.actors} actors, ${fixture.operations} operations/phase`);
    const run = await runFixture(fixture, timeout);
    report.runs.push(run);
    console.table(run.phases.filter((phase) => phase.kind === "workload").map((phase) => ({
      phase: phase.name, units: phase.units, unit: phase.unit, read: phase.rowsRead, written: phase.rowsWritten,
      "read/unit": +(phase.rowsRead / phase.units).toFixed(2), "written/unit": +(phase.rowsWritten / phase.units).toFixed(2),
    })));
    for (const kind of ["setup", "workload", "verification"] as const) console.log(`${kind}: ${JSON.stringify(sumCosts(run.phases.filter((phase) => phase.kind === kind)))}`);
  }
  report.scaling = observeScaling(report);
  for (const observation of report.scaling.filter((entry) => entry.expectation === "investigate" && entry.grewMaterially)) {
    console.warn(`Investigate scaling: ${observation.preset} ${observation.phase}, ${observation.smallPosts} → ${observation.largePosts} posts, reads/unit ${observation.readPerUnit.map((n) => n.toFixed(2)).join(" → ")}, writes/unit ${observation.writtenPerUnit.map((n) => n.toFixed(2)).join(" → ")}`);
  }
  if (values.projection) {
    const projection = JSON.parse(await readFile(resolve(values.projection), "utf8")) as { days: number; dailyUnits: Record<string, number> };
    report.projections = report.runs.map((run) => ({ fixture: run.fixture, ...projectUsage(run, projection.dailyUnits, projection.days) }));
  }
  const output = resolve(values.output ?? join(ROOT, "results/cost-latest.json"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${output}`);
  const failures = checkScaling(report);
  if (values.baseline) failures.push(...compareBaseline(report, JSON.parse(await readFile(resolve(values.baseline), "utf8")) as Baseline));
  if (failures.length) throw new Error(`Cost guardrails failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  if (values["write-baseline"]) {
    const path = resolve(values["write-baseline"]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(createBaseline(report), null, 2) + "\n");
    console.log(`Baseline written: ${path} (review before committing)`);
  }
  console.log(`Correctness and unrelated-data scaling checks passed. ${values.baseline ? "Reviewed cost ceilings passed." : "No baseline ceilings checked."} Local accounting; not a production billing guarantee.`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
