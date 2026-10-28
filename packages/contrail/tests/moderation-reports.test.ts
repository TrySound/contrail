import { beforeAll, describe, expect, it, vi } from "vitest";
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
  // Reports are only accepted for subjects the instance indexes.
  await db
    .prepare("INSERT INTO identities (did, pds, resolved_at) VALUES (?, ?, ?)")
    .bind(reporter, "https://pds.example", Date.now())
    .run();
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
  it.each([undefined,
    "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
    "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])("includes profile-scoped labels in account previews with CID filtering (pin=%s)", async (subjectCid) => {
    const { db, config } = await setup();
    const collection = "com.example.profile";
    const cid = "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
    const uri = `at://${reporter}/${collection}/self`;
    const withProfile = resolveConfig({ ...config,
      profiles: [{ collection, shortName: "profile" }],
      collections: { ...config.collections, profile: { collection } },
    });
    await initSchema(db, withProfile);
    await ingestRecords(db, [
      createIngestEvent({ did: reporter, collection, rkey: "self", operation: "create", cid,
        timeUs: 100, value: { displayName: "Test" } }),
      createIngestEvent({ did: moderator, collection: MODERATION_ACTION_NSID,
        rkey: "profile-hide", operation: "create", cid: "actioncid", timeUs: 101,
        value: { subject: uri, action: "!hide", subjectCid, createdAt: new Date().toISOString() } }),
    ], withProfile);
    expect(await db.prepare("SELECT cid FROM moderation_actions WHERE uri = ?")
      .bind(`at://${moderator}/${MODERATION_ACTION_NSID}/profile-hide`).first())
      .toEqual({ cid: subjectCid ?? null });
    const app = createApp(db, withProfile);
    expect((await request(app, "com.atproto.moderation.createReport", reporter, report)).status).toBe(200);
    const inbox = await request(app, "com.example.moderation.listReports", moderator);
    expect(inbox.status).toBe(200);
    const preview = ((await inbox.json()) as any).reports[0].preview;
    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].uri).toBe(uri);
    if (!subjectCid || subjectCid === cid) {
      expect(preview.labels[uri]).toMatchObject([{ val: "!hide", uri, src: moderator }]);
    } else expect(preview.labels[uri]).toBeUndefined();
    expect(preview.labels[reporter]).toBeUndefined(); // A record label is not a DID label.
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
          padding: "x".repeat(128 * 1024),
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
  it("accepts valid reasons above 16 KiB, including fully escaped JSON", async () => {
    const { app, db } = await setup();
    // 1000 graphemes, exactly 20,000 UTF-8 bytes, but >60 KiB when escaped.
    const reason = ("e" + "\u0301".repeat(9)).repeat(1000) + "\u0301".repeat(500);
    expect(new TextEncoder().encode(reason)).toHaveLength(20_000);
    for (const escaped of [false, true]) {
      const token = await createServiceJwt({ keypair: key, issuer: reporter, audience,
        lxm: "com.atproto.moderation.createReport" });
      let body = JSON.stringify({ ...report, reason });
      if (escaped) {
        const escapedReason = Array.from(reason,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
        body = body.replace(JSON.stringify(reason), `"${escapedReason}"`);
        expect(new TextEncoder().encode(body).length).toBeGreaterThan(60 * 1024);
      }
      const response = await app.request("/xrpc/com.atproto.moderation.createReport", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).reason).toBe(reason);
    }
    expect((await request(app, "com.atproto.moderation.createReport", reporter,
      { ...report, reason: reason + "\u0301" })).status).toBe(400);
    expect((await db.prepare("SELECT used FROM moderation_report_limits").first<any>()).used).toBe(2);
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
    // The Lexicon limit counts graphemes: 2000 "e" + combining accent pairs fit.
    expect(
      (
        await request(app, "com.atproto.moderation.createReport", reporter, {
          ...report,
          reason: "e\u0301".repeat(2000),
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 9; i++)
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
  it("rejects subjects this instance does not index without consuming quota", async () => {
    const { app, db } = await setup();
    for (const subject of [
      { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:cccccccccccccccccccccccc" },
      {
        $type: "com.atproto.repo.strongRef",
        uri: `at://${reporter}/com.example.unindexed/a`,
        cid: "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      },
    ]) {
      const response = await request(app, "com.atproto.moderation.createReport", reporter, {
        ...report,
        subject,
      });
      expect(response.status).toBe(400);
    }
    expect((await db.prepare("SELECT * FROM moderation_report_limits").all()).results).toEqual([]);
  });
  it("retries a colliding random report ID instead of failing", async () => {
    const { app, db } = await setup();
    const random = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      // Report IDs use 6-byte arrays; the first two reports draw the same ID.
      if (array.length !== 6) return random(array);
      array.fill(calls++ < 2 ? 1 : 2);
      return array;
    }) as typeof crypto.getRandomValues);
    try {
      for (let i = 0; i < 2; i++)
        expect((await request(app, "com.atproto.moderation.createReport", reporter, report)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect((await db.prepare("SELECT * FROM moderation_reports").all()).results).toHaveLength(2);
    expect(
      (await db.prepare("SELECT used FROM moderation_report_limits").first<{ used: number }>())!.used,
    ).toBe(2);
  });
  it("builds inbox previews with a query count independent of page size", async () => {
    const { db, config } = await setup();
    let queries = 0;
    const counting = {
      dialect: db.dialect,
      prepare: (sql: string) => (queries++, db.prepare(sql)),
      batch: (stmts: any[]) => db.batch(stmts),
    };
    const app = createApp(counting as typeof db, config);
    const list = async () => {
      queries = 0;
      const response = await request(app, "com.example.moderation.listReports", moderator);
      expect(response.status).toBe(200);
      return { queries, reports: ((await response.json()) as any).reports.length };
    };
    await request(app, "com.atproto.moderation.createReport", reporter, report);
    const one = await list();
    for (let i = 0; i < 6; i++)
      await request(app, "com.atproto.moderation.createReport", reporter, report);
    const seven = await list();
    expect([one.reports, seven.reports]).toEqual([1, 7]);
    expect(seven.queries).toBe(one.queries);
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
