import type { ContrailConfig, Database } from "@atmo-dev/contrail";
import { createApp } from "../../../../packages/contrail/src/core/router";
import { registerModerationRoutes } from "../../../../packages/contrail/src/core/router/moderation";
import type { ServiceAuthGate } from "../../../../packages/contrail/src/core/service-auth";
import type { createCostMeter } from "./meter";
import { actor } from "./fixture";

/** Exercise the real private report routes after authentication. The gate is
 * deliberately synthetic: signature verification/DID resolution are not D1
 * operations and must not introduce live networking into this SQL workload. */
export async function runReportWorkloads(
  db: Database, config: ContrailConfig, meter: ReturnType<typeof createCostMeter>, operations: number, actors: number,
) {
  const app = createApp(db, config); // Base fixture disables reports; attach them with the preauthenticated gate below.
  const audience = "did:web:cost.invalid#contrail";
  const gate: ServiceAuthGate = {
    serviceDid: "did:web:cost.invalid", audience, protects: () => true,
    async authorize(request, method) {
      return { principal: { issuer: request.headers.get("x-cost-issuer") as `did:plc:${string}`, audience, lxm: method } };
    },
  };
  const reportsConfig = { ...config, moderation: { ...config.moderation!, reports: true } };
  registerModerationRoutes(app, db, reportsConfig, gate);
  let assertions = 0;
  async function request(method: string, issuer: string, body?: object, params = "") {
    return await app.request(`/xrpc/${method}${params}`, {
      method: body ? "POST" : "GET", headers: { "x-cost-issuer": issuer, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(`Report cost workload failed: ${message}`);
    assertions++;
  }
  const body = {
    subject: { $type: "com.atproto.admin.defs#repoRef", did: actor(1) },
    reasonType: "com.atproto.moderation.defs#reasonSpam", reason: "Synthetic cost fixture",
  };
  const ids: number[] = [];
  const count = Math.min(operations, actors * 9);
  await meter.measure("moderation.report-create", "workload", count, "report", async () => {
    for (let i = 0; i < count; i++) {
      const response = await request("com.atproto.moderation.createReport", actor(i % actors), body);
      check(response.status === 200, `create status ${response.status}`);
      ids.push((await response.json() as { id: number }).id);
    }
    meter.note("reportsCreated", ids.length);
  });
  await meter.measure("moderation.report-inbox", "workload", operations, "request", async () => {
    for (let i = 0; i < operations; i++) {
      const response = await request(`${config.namespace}.moderation.listReports`, config.moderation!.moderators[0]!, undefined, "?limit=20");
      check(response.status === 200, "inbox status");
      const result = await response.json() as { reports: Array<{ preview: unknown; reason: string }> };
      check(result.reports.length === Math.min(20, count) && result.reports.every((report) => report.preview && report.reason === body.reason), "inbox previews and private evidence");
    }
  });
  await meter.measure("moderation.report-resolve", "workload", ids.length, "report", async () => {
    for (const id of ids) {
      const response = await request(`${config.namespace}.moderation.resolveReport`, config.moderation!.moderators[0]!, { id, resolution: "Reviewed synthetic report" });
      check(response.status === 200, "resolve status");
    }
  });
  const usedByFirstActor = Math.ceil(count / actors);
  if (usedByFirstActor < 10) await meter.measure("setup.report-quota", "setup", 10 - usedByFirstActor, "report", async () => {
    for (let i = usedByFirstActor; i < 10; i++) {
      const response = await request("com.atproto.moderation.createReport", actor(0), body);
      check(response.status === 200, "prepare exhausted report quota");
    }
  });
  await meter.measure("abuse.report-quota", "workload", operations, "request", async () => {
    for (let i = 0; i < operations; i++) {
      const response = await request("com.atproto.moderation.createReport", actor(0), body);
      check(response.status === 429, "exhausted report quota rejects more writes");
    }
    meter.note("rateLimited", operations);
  });
  await meter.measure("verify.reports", "verification", 1, "check-set", async () => {
    const resolved = await db.prepare("SELECT COUNT(*) AS n FROM moderation_reports WHERE status = 'resolved'").first<{ n: number }>();
    const total = await db.prepare("SELECT COUNT(*) AS n FROM moderation_reports").first<{ n: number }>();
    check(resolved?.n === count && total?.n === count + 10 - usedByFirstActor, "reports retained/resolved; quota flood causes no report growth");
    const response = await request(`${config.namespace}.moderation.listReports`, actor(0));
    check(response.status === 403, "ordinary reporter cannot read private inbox");
  });
  return assertions;
}
