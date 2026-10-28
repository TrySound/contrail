import type { Database } from "@atmo-dev/contrail";
import { runCostSuite } from "./cost/suite";
import type { FixtureOptions } from "./cost/fixture";

let used = false;
export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path !== "/run" || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (used) return new Response("Each fixture requires a fresh database/runtime", { status: 409 });
    used = true;
    try {
      return Response.json(await runCostSuite(env.DB, await request.json() as FixtureOptions));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.stack : String(error) }, { status: 500 });
    }
  },
};
