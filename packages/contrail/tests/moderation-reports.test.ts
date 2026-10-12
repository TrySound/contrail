import { beforeAll, describe, expect, it } from "vitest";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import type { AtprotoAudience, Did, Nsid } from "@atcute/lexicons/syntax";
import { createTestDb } from "./helpers";
import {
  createApp,
  initSchema,
  resolveConfig,
  initModerationReports,
  createIngestEvent,
  ingestRecords,
  MODERATION_ACTION_NSID,
} from "../src/index";
const moderator = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as Did;
const reporter = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" as Did;
const audience = "did:web:api.example.com#contrail" as AtprotoAudience;
let key: Secp256k1PrivateKeyExportable;
beforeAll(async () => {
  key = await Secp256k1PrivateKeyExportable.createKeypair();
});
async function setup() {
  const config = resolveConfig({
    namespace: "com.example",
    collections: {},
    profiles: [],
    moderation: { moderators: [moderator] },
    serviceAuth: {
      audience,
      methods: [],
      resolver: {
        async resolve(did) {
          return {
            "@context": [],
            id: did,
            verificationMethod: [
              {
                id: `${did}#atproto`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase: await key.exportPublicKey("multikey"),
              },
            ],
          };
        },
      },
    },
  });
  const db = createTestDb();
  await initSchema(db, config);
  return { config, db, app: createApp(db, config) };
}
async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  issuer = reporter,
  body?: unknown,
  params = "",
  jwtMethod = method,
) {
  const jwt = await createServiceJwt({
    keypair: key,
    issuer,
    audience,
    lxm: jwtMethod as Nsid,
  });
  return app.request(`/xrpc/${method}${params}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const report = {
  reasonType: "com.atproto.moderation.defs#reasonSpam",
  reason: "private evidence",
  subject: { $type: "com.atproto.admin.defs#repoRef", did: reporter },
};

describe("private moderation reports", () => {
  it("includes current author declarations in locally indexed hidden profile previews", async () => {
    const { db, config } = await setup();
    const collection = "com.example.profile";
    const withProfile = resolveConfig({ ...config,
      profiles: [{ collection, shortName: "profile" }],
      collections: { ...config.collections, profile: { collection } },
    });
    await initSchema(db, withProfile);
    const app = createApp(db, withProfile);
    await ingestRecords(db, [createIngestEvent({ did: reporter, collection,
      rkey: "self", operation: "create", cid: "profilecid", timeUs: 100,
      value: { labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] } },
    }), createIngestEvent({ did: moderator, collection: MODERATION_ACTION_NSID,
      rkey: "hide", operation: "create", cid: "actioncid", timeUs: 101,
      value: { subject: reporter, action: "!hide", createdAt: new Date().toISOString() },
    })], withProfile);
    expect((await app.request(`/xrpc/com.example.getProfile?actor=${reporter}`)).status).toBe(404);
    const created = await request(app, "com.atproto.moderation.createReport", reporter, report);
    expect(created.status).toBe(200);
    const inbox = await request(app, "com.example.moderation.listReports", moderator);
    const preview = ((await inbox.json()) as any).reports[0].preview;
    expect(preview.hidden).toBe(true);
    expect(preview.records[0].selfLabels).toEqual([{ val: "nudity" }]);
    expect(preview.records[0].value.labels.values).toEqual([{ val: "nudity" }]);
  });
  it("requires audience configuration and publishes exact method-bound auth", async () => {
    expect(() =>
      resolveConfig({
        namespace: "com.example",
        collections: {},
        moderation: { moderators: [moderator] },
      }),
    ).toThrow("serviceAuth");
    const { config } = await setup();
    expect(config.serviceAuth?.methods).toEqual([
      "createReport",
      "listReports",
      "resolveReport",
    ]);
  });
  it("requires auth and rejects method replay and non-moderator inbox access", async () => {
    const { app } = await setup();
    expect(
      (
        await app.request("/xrpc/com.atproto.moderation.createReport", {
          method: "POST",
          body: JSON.stringify(report),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          app,
          "com.atproto.moderation.createReport",
          reporter,
          report,
          "",
          "com.example.moderation.listReports",
        )
      ).status,
    ).toBe(401);
    expect(
      (await request(app, "com.example.moderation.listReports")).status,
    ).toBe(403);
  });
  it("stores standard reports privately, resolves idempotently, and retains them through schema initialization", async () => {
    const { app, db, config } = await setup();
    const response = await request(
      app,
      "com.atproto.moderation.createReport",
      reporter,
      report,
    );
    expect(response.status).toBe(200);
    const created: any = await response.json();
    expect(created.reportedBy).toBe(reporter);
    expect(created.subject).toEqual(report.subject);
    const padded = await request(app, "com.atproto.moderation.createReport", reporter, {
      ...report,
      subject: { ...report.subject, extra: "x".repeat(1000) },
    });
    expect(((await padded.json()) as any).subject).toEqual(report.subject);
    const inbox = await request(
      app,
      "com.example.moderation.listReports",
      moderator,
    );
    expect(inbox.headers.get("cache-control")).toBe("no-store");
    expect(((await inbox.json()) as any).reports[0].reason).toBe(
      "private evidence",
    );
    expect(
      (
        await request(app, "com.example.moderation.resolveReport", reporter, {
          id: created.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app, "com.example.moderation.resolveReport", moderator, {
          id: created.id,
          resolution: "done",
        })
      ).status,
    ).toBe(200);
    await request(app, "com.example.moderation.resolveReport", moderator, {
      id: created.id,
      resolution: "overwrite",
    });
    expect(
      (
        await db
          .prepare("SELECT resolution FROM moderation_reports WHERE id = ?")
          .bind(String(created.id))
          .first<any>()
      ).resolution,
    ).toBe("done");
    await initSchema(db, config);
    expect(
      (
        (await request(
          app,
          "com.example.moderation.listReports",
          moderator,
          undefined,
          "?status=resolved",
        ).then((r) => r.json())) as any
      ).reports,
    ).toHaveLength(1);
  });
  it("keeps reports in stable instance storage when the projection database is replaced", async () => {
    const { config, db } = await setup();
    const reportsDb = createTestDb();
    await initModerationReports(reportsDb);
    const app = createApp(db, config, { reportsDb });
    expect(
      (
        await request(
          app,
          "com.atproto.moderation.createReport",
          reporter,
          report,
        )
      ).status,
    ).toBe(200);
    expect(
      (await db.prepare("SELECT * FROM moderation_reports").all()).results,
    ).toEqual([]);
    const nextProjection = createTestDb();
    await initSchema(nextProjection, config);
    const nextApp = createApp(nextProjection, config, { reportsDb });
    const inbox: any = await request(
      nextApp,
      "com.example.moderation.listReports",
      moderator,
    ).then((r) => r.json());
    expect(inbox.reports).toHaveLength(1);
    expect(inbox.reports[0].reason).toBe("private evidence");
  });
  it("rejects oversized bodies before storing reports or consuming quota", async () => {
    const { app, db } = await setup();
    expect(
      (
        await request(app, "com.atproto.moderation.createReport", reporter, {
          ...report,
          padding: "x".repeat(20_000),
        })
      ).status,
    ).toBe(400);
    expect(
      (await db.prepare("SELECT * FROM moderation_reports").all()).results,
    ).toEqual([]);
    expect(
      (await db.prepare("SELECT * FROM moderation_report_limits").all())
        .results,
    ).toEqual([]);
  });
  it("enforces a transaction-safe per-reporter quota and validates reasons/subjects", async () => {
    const { app, db } = await setup();
    expect(
      (
        await request(app, "com.atproto.moderation.createReport", reporter, {
          ...report,
          reasonType: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, "com.atproto.moderation.createReport", reporter, {
          ...report,
          reason: "a".repeat(2001),
        })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 10; i++)
      expect(
        (
          await request(
            app,
            "com.atproto.moderation.createReport",
            reporter,
            report,
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await request(
          app,
          "com.atproto.moderation.createReport",
          reporter,
          report,
        )
      ).status,
    ).toBe(429);
    expect(
      (await db.prepare("SELECT * FROM moderation_reports").all()).results,
    ).toHaveLength(10);
  });
  it("paginates stable equal-time reports and rejects bad cursor/unknown resolution", async () => {
    const { app, db } = await setup();
    for (let i = 0; i < 3; i++)
      await request(
        app,
        "com.atproto.moderation.createReport",
        reporter,
        report,
      );
    await db.prepare("UPDATE moderation_reports SET created_at = 123").run();
    const first: any = await request(
      app,
      "com.example.moderation.listReports",
      moderator,
      undefined,
      "?limit=2",
    ).then((r) => r.json());
    const next: any = await request(
      app,
      "com.example.moderation.listReports",
      moderator,
      undefined,
      `?limit=2&cursor=${encodeURIComponent(first.cursor)}`,
    ).then((r) => r.json());
    expect(next.reports).toHaveLength(1);
    expect(first.reports.map((r: any) => r.id)).not.toContain(
      next.reports[0].id,
    );
    expect(
      (
        await request(
          app,
          "com.example.moderation.listReports",
          moderator,
          undefined,
          "?cursor=nope",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, "com.example.moderation.resolveReport", moderator, {
          id: 0,
        })
      ).status,
    ).toBe(404);
  });
});
