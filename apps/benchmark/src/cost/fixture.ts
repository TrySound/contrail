import { createIngestEvent, resolveConfig } from "../../../../packages/contrail/src/index";
import type { ContrailConfig, IngestEvent } from "@atmo-dev/contrail";

import { FIXED_NOW, validateFixture, type FixtureOptions } from "./model";
export { BATCH_SIZE, FIXED_NOW, type FixtureOptions } from "./model";
export const LABELER = "did:plc:costlabeler";
export const MODERATOR = "did:plc:costmoderator";
export const NSIDS = {
  post: "tools.cost.post", comment: "tools.cost.comment", reaction: "tools.cost.reaction",
  profile: "tools.cost.profile", follow: "tools.cost.follow",
};
export function actor(index: number): string { return `did:plc:cost${String(index).padStart(8, "0")}`; }

export function makeFixture(options: FixtureOptions) {
  validateFixture(options);
  const moderated = options.preset !== "core";
  const full = options.preset === "full";
  let randomState = options.seed;
  function random() {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  }
  let sequence = 0;
  const value = (i: number) => ({
    $type: NSIDS.post,
    text: `Cost fixture post ${i} topic${Math.floor(random() * 8)} ${"sample content ".repeat(12)}`,
    category: i % 2 ? "photos" : "notes",
    createdAt: new Date(FIXED_NOW - 86_400_000 + i * 10).toISOString(),
  });
  function event(
    collection: string, did: string, rkey: string, record: object | null,
    operation: "create" | "update" | "delete" = "create", cid?: string | null,
  ): IngestEvent {
    sequence++;
    return createIngestEvent({
      did, collection, rkey, operation, value: record,
      // Opaque synthetic CIDs: these scenarios measure SQL, not Lexicon/CID validation CPU.
      cid: operation === "delete" ? null : (cid ?? `fixture-cid-${sequence}`),
      timeUs: (FIXED_NOW - 1_000_000) * 1000 + sequence,
      indexedAt: FIXED_NOW * 1000,
      source: { id: "local", epoch: "cost-v1", time_us: sequence, cursor: String(sequence) },
    });
  }
  const config = resolveConfig({
    namespace: "tools.cost",
    collections: {
      post: {
        collection: NSIDS.post,
        queryable: { category: {}, createdAt: { type: "range" } },
        searchable: ["text"],
        relations: {
          comments: { collection: "comment" },
          reactions: { collection: "reaction", groupBy: "kind", groups: { like: "like", love: "love" } },
        },
      },
      comment: {
        collection: NSIDS.comment,
        references: { post: { collection: "post", field: "subject.uri" } },
      },
      reaction: { collection: NSIDS.reaction },
      ...(full ? {
        profile: { collection: NSIDS.profile, discover: false },
        follow: { collection: NSIDS.follow, discover: false, subjectField: "subject" },
      } : {}),
    },
    ...(full ? {
      profiles: [NSIDS.profile],
      feeds: { following: { follow: "follow", targets: ["post"], maxItems: 100 } },
    } : {}),
    ...(moderated ? {
      moderation: { moderators: [MODERATOR], reports: false },
      labels: { sources: [{ did: LABELER, enforce: true, values: ["!hide", "warn"] }] },
    } : {}),
    // Fail on swallowed maintenance/enrichment errors; a cheap failed operation is not a win.
    logger: {
      log() {},
      warn(...args) { throw new Error(`Unexpected warning: ${args.join(" ")}`); },
      error(...args) { throw new Error(`Unexpected error: ${args.join(" ")}`); },
    },
  } satisfies ContrailConfig);
  const posts = Array.from({ length: options.posts }, (_, i) =>
    event(NSIDS.post, actor(i % options.actors), `p${i}`, value(i)));
  const comments = posts.map((post, i) => event(NSIDS.comment, actor((i + 1) % options.actors), `c${i}`, {
    $type: NSIDS.comment, subject: { uri: post.uri }, text: `Comment ${i}`,
  }));
  const reactions = posts.map((post, i) => event(NSIDS.reaction, actor((i + 2) % options.actors), `r${i}`, {
    $type: NSIDS.reaction, subject: { uri: post.uri }, kind: i % 2 ? "like" : "love",
  }));
  const hotReactions = posts.filter((_, i) => i % 4 === 0).map((_, i) =>
    event(NSIDS.reaction, actor(i % options.actors), `hot${i}`, {
      $type: NSIDS.reaction, subject: { uri: posts[0]!.uri }, kind: "like",
    }));
  return { options, config, full, moderated, posts, comments, reactions, hotReactions, event, value };
}
