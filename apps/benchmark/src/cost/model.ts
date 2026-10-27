export const FIXTURE_VERSION = 1;
export const FIXED_NOW = Date.parse("2026-09-01T12:00:00.000Z");
export const BATCH_SIZE = 25;
export interface FixtureOptions {
  posts: number;
  actors: number;
  operations: number;
  seed: number;
  preset: "core" | "moderation" | "full";
}

export function validateFixture(input: FixtureOptions): FixtureOptions {
  const ranges = { posts: [16, 1_000_000], actors: [4, 10_000], operations: [1, 10_000], seed: [0, 0xffff_ffff] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = input[key as keyof typeof ranges];
    if (!Number.isSafeInteger(value) || value < min! || value > max!) throw new Error(`Invalid fixture ${key}: ${value}`);
  }
  if (!["core", "moderation", "full"].includes(input.preset)) throw new Error(`Unknown preset: ${input.preset}`);
  return input;
}
