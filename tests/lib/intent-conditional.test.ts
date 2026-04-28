// Tests for intent-conditional rerank + intent embedding cache (v0.5.0).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  intentConditionalRerank,
  type SkillIntentMap,
} from "../../src/lib/rerank.js";
import { IntentEmbeddingCache } from "../../src/lib/intent-cache.js";
import { createStubEmbedder } from "../../src/lib/embed.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-icond-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const buildIntentMap = (
  data: Array<{ skill_id: string; intent: string; vec: number[]; daysAgo?: number }>,
): SkillIntentMap => {
  const map: SkillIntentMap = new Map();
  for (const d of data) {
    const arr = map.get(d.skill_id) ?? [];
    arr.push({
      intent: d.intent,
      vec: d.vec,
      timestamp: new Date(Date.now() - (d.daysAgo ?? 0) * 86400000).toISOString(),
    });
    map.set(d.skill_id, arr);
  }
  return map;
};

describe("intentConditionalRerank", () => {
  it("does not boost a skill whose past intents are dissimilar to the query", () => {
    // Skill A has 50 past intents, ALL with vec orthogonal to query.
    const queryVec = [1, 0, 0, 0];
    const orthogonal = [0, 1, 0, 0]; // cos(query, orthogonal) = 0 < threshold
    const intents = Array.from({ length: 50 }, (_, i) => ({
      skill_id: "A",
      intent: `unrelated-${i}`,
      vec: orthogonal,
    }));
    const map = buildIntentMap(intents);

    const out = intentConditionalRerank(
      [
        { skill_id: "A", cosine: 0.7 },
        { skill_id: "B", cosine: 0.6 },
      ],
      queryVec,
      map,
    );

    // A has 50 past uses but ZERO are similar to query → no boost.
    // B has 0 past uses → no boost. Cosine ordering preserved.
    expect(out[0]?.skill_id).toBe("A");
    expect(out[0]?.conditional_count).toBe(0);
    expect(out[0]?.usage_boost).toBe(0);
    expect(out[1]?.skill_id).toBe("B");
  });

  it("boosts a skill when its past intents are similar to the query", () => {
    const queryVec = [1, 0, 0, 0];
    // Skill A has 5 past intents that are very similar to query.
    const map = buildIntentMap([
      { skill_id: "A", intent: "p1", vec: [0.95, 0.1, 0.1, 0.1] },
      { skill_id: "A", intent: "p2", vec: [0.96, 0.1, 0.1, 0.1] },
      { skill_id: "A", intent: "p3", vec: [0.94, 0.1, 0.1, 0.1] },
      { skill_id: "A", intent: "p4", vec: [0.97, 0.1, 0.1, 0.1] },
      { skill_id: "A", intent: "p5", vec: [0.95, 0.1, 0.1, 0.1] },
    ]);

    const out = intentConditionalRerank(
      [
        { skill_id: "A", cosine: 0.50 },
        { skill_id: "B", cosine: 0.55 }, // wins on cosine
      ],
      queryVec,
      map,
      { similarityThreshold: 0.7 },
    );

    // A has 5 similar past intents → +0.05*log(6) ≈ +0.090 boost.
    // 0.50 + 0.090 = 0.590 vs B's 0.55. A should win.
    expect(out[0]?.skill_id).toBe("A");
    expect(out[0]?.conditional_count).toBe(5);
  });

  it("similarity threshold filters partial matches", () => {
    const queryVec = [1, 0, 0, 0];
    // Skill A has 3 strong matches and 7 weak matches.
    const data = [
      ...Array.from({ length: 3 }, (_, i) => ({ skill_id: "A", intent: `strong-${i}`, vec: [0.95, 0.1, 0, 0] })),
      ...Array.from({ length: 7 }, (_, i) => ({ skill_id: "A", intent: `weak-${i}`,   vec: [0.5, 0.5, 0, 0] })),
    ];
    const map = buildIntentMap(data);

    const tight = intentConditionalRerank(
      [{ skill_id: "A", cosine: 0.5 }],
      queryVec,
      map,
      { similarityThreshold: 0.9 },
    );
    expect(tight[0]?.conditional_count).toBe(3);
    expect(tight[0]?.usage_count).toBe(10); // total still reported

    const loose = intentConditionalRerank(
      [{ skill_id: "A", cosine: 0.5 }],
      queryVec,
      map,
      { similarityThreshold: 0.5 },
    );
    expect(loose[0]?.conditional_count).toBe(10);
  });

  it("recency_boost only counts intents that pass the similarity filter", () => {
    const queryVec = [1, 0, 0, 0];
    // Skill A: an old similar intent (30 days ago) + a recent dissimilar one.
    const map = buildIntentMap([
      { skill_id: "A", intent: "old-relevant", vec: [0.95, 0.1, 0, 0], daysAgo: 30 },
      { skill_id: "A", intent: "new-irrelevant", vec: [0, 1, 0, 0], daysAgo: 0 },
    ]);

    const out = intentConditionalRerank(
      [{ skill_id: "A", cosine: 0.5 }],
      queryVec,
      map,
      { similarityThreshold: 0.7 },
    );

    // Only the 30-days-ago intent counts → recency_boost is small (30 days
    // is ~4 half-lives, so 2^-4 ≈ 0.0625, times β=0.03 → ~0.002).
    expect(out[0]?.conditional_count).toBe(1);
    expect(out[0]?.recency_boost).toBeLessThan(0.005);
    expect(out[0]?.recency_boost).toBeGreaterThan(0);
  });

  it("falls through gracefully when no past intents exist", () => {
    const out = intentConditionalRerank(
      [{ skill_id: "A", cosine: 0.5 }],
      [1, 0, 0, 0],
      new Map(), // empty
    );
    expect(out[0]?.conditional_count).toBe(0);
    expect(out[0]?.usage_boost).toBe(0);
    expect(out[0]?.final_score).toBe(0.5);
  });
});

describe("IntentEmbeddingCache", () => {
  it("caches embeddings keyed by intent string", async () => {
    const cachePath = join(tmpDir, "intent-embeddings.json");
    const embedder = createStubEmbedder(32);
    const cache = new IntentEmbeddingCache(cachePath, embedder);

    const v1 = await cache.getOrEmbed("hello world");
    const v2 = await cache.getOrEmbed("hello world");

    expect(v1).toEqual(v2);
    expect(v1.length).toBe(32);
    expect(cache.size()).toBe(1);
  });

  it("persists + reloads from disk; survives different cache instances", async () => {
    const cachePath = join(tmpDir, "intent-embeddings.json");
    const embedder = createStubEmbedder(32);

    const c1 = new IntentEmbeddingCache(cachePath, embedder);
    await c1.embedBatch(["one", "two", "three"]);
    expect(c1.size()).toBe(3);

    const file = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(file);
    expect(parsed.embedding_model).toBe("stub:fnv1a-32");
    expect(Object.keys(parsed.embeddings).length).toBe(3);

    // New cache instance reads from disk
    const c2 = new IntentEmbeddingCache(cachePath, embedder);
    await c2.load();
    expect(c2.size()).toBe(3);
  });

  it("invalidates the cache if the embedding model changes", async () => {
    const cachePath = join(tmpDir, "intent-embeddings.json");

    const e32 = createStubEmbedder(32);
    const c1 = new IntentEmbeddingCache(cachePath, e32);
    await c1.embedBatch(["foo"]);
    expect(c1.size()).toBe(1);

    // Different model — cache should not load entries
    const e64 = createStubEmbedder(64);
    const c2 = new IntentEmbeddingCache(cachePath, e64);
    await c2.load();
    expect(c2.size()).toBe(0);
  });

  it("embedBatch deduplicates: only embeds each unique intent once", async () => {
    let callCount = 0;
    const countingEmbedder = {
      name: "counting:32",
      dim: 32,
      async embed(text: string): Promise<number[]> {
        callCount++;
        return new Array(32).fill(text.length / 100);
      },
    };
    const cache = new IntentEmbeddingCache(join(tmpDir, "x.json"), countingEmbedder);
    await cache.embedBatch(["a", "b", "a", "b", "c", "a"]);
    expect(callCount).toBe(3); // a, b, c — each once
    expect(cache.size()).toBe(3);
  });
});
