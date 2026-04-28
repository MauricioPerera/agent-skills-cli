import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  computeRecency,
  rerank,
  type SkillUsageStats,
} from "../../src/lib/rerank.js";
import type { AuditEntry } from "../../src/lib/bank.js";

const auditFor = (skill_id: string, exit_code: number, daysAgo: number): AuditEntry => ({
  timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  skill_id,
  args: {},
  exit_code,
  elapsed_ms: 100,
});

describe("aggregateUsage", () => {
  it("counts entries + success per skill", () => {
    const stats = aggregateUsage([
      auditFor("a", 0, 1),
      auditFor("a", 0, 2),
      auditFor("a", 1, 3), // failure
      auditFor("b", 0, 0.5),
    ]);
    expect(stats.get("a")).toMatchObject({ count: 3, success_count: 2 });
    expect(stats.get("b")).toMatchObject({ count: 1, success_count: 1 });
  });

  it("tracks last_used as the most recent timestamp", () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const stats = aggregateUsage([
      { timestamp: old, skill_id: "x", args: {}, exit_code: 0, elapsed_ms: 1 },
      { timestamp: recent, skill_id: "x", args: {}, exit_code: 0, elapsed_ms: 1 },
    ]);
    expect(stats.get("x")?.last_used).toBe(recent);
  });

  it("returns empty map on empty input", () => {
    expect(aggregateUsage([]).size).toBe(0);
  });
});

describe("computeRecency", () => {
  const now = "2026-04-28T12:00:00Z";

  it("returns 1.0 when last_used is now", () => {
    expect(computeRecency(now, now)).toBeCloseTo(1.0);
  });

  it("returns 0.5 at the half-life", () => {
    const halfLifeAgo = new Date(Date.parse(now) - 7 * 86400000).toISOString();
    expect(computeRecency(halfLifeAgo, now, 7)).toBeCloseTo(0.5);
  });

  it("returns 0 when last_used is null", () => {
    expect(computeRecency(null, now)).toBe(0);
  });

  it("returns 0 when last_used is in the future (clock skew defense)", () => {
    const future = new Date(Date.parse(now) + 86400000).toISOString();
    expect(computeRecency(future, now)).toBe(0);
  });

  it("decays toward 0 for very old entries", () => {
    const oneYearAgo = new Date(Date.parse(now) - 365 * 86400000).toISOString();
    expect(computeRecency(oneYearAgo, now, 7)).toBeLessThan(0.001);
  });
});

describe("rerank", () => {
  const stats = (count: number, lastUsedDaysAgo: number | null = null): SkillUsageStats => ({
    count,
    success_count: count,
    last_used: lastUsedDaysAgo === null ? null : new Date(Date.now() - lastUsedDaysAgo * 86400000).toISOString(),
  });

  it("preserves order when all skills have zero usage", () => {
    const usageMap = new Map<string, SkillUsageStats>();
    const out = rerank(
      [
        { skill_id: "a", cosine: 0.8 },
        { skill_id: "b", cosine: 0.7 },
        { skill_id: "c", cosine: 0.6 },
      ],
      usageMap,
    );
    expect(out.map((o) => o.skill_id)).toEqual(["a", "b", "c"]);
    expect(out.every((o) => o.usage_boost === 0)).toBe(true);
  });

  it("usage_count promotes a slightly-worse-cosine skill above a fresh one", () => {
    const usageMap = new Map([
      ["a", stats(0)],
      ["b", stats(100, 1)], // 100 successful uses, 1 day ago
    ]);
    const out = rerank(
      [
        { skill_id: "a", cosine: 0.75 },
        { skill_id: "b", cosine: 0.70 },
      ],
      usageMap,
    );
    // b has 100 uses → log(101) × 0.05 = +0.231 boost. a has 0 → +0.
    // b's final: 0.70 + 0.231 + recency ≈ 0.95+. a's: 0.75. b wins.
    expect(out[0]?.skill_id).toBe("b");
  });

  it("when α = 0, usage has zero effect (cosine-only ordering)", () => {
    const usageMap = new Map([["b", stats(1000, 0)]]);
    const out = rerank(
      [
        { skill_id: "a", cosine: 0.75 },
        { skill_id: "b", cosine: 0.70 },
      ],
      usageMap,
      { alpha: 0, beta: 0 },
    );
    expect(out[0]?.skill_id).toBe("a");
  });

  it("breakdown fields are populated correctly", () => {
    const usageMap = new Map([["x", stats(10, 2)]]);
    const out = rerank([{ skill_id: "x", cosine: 0.5 }], usageMap);
    const first = out[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.cosine).toBe(0.5);
    expect(first.usage_count).toBe(10);
    expect(first.usage_boost).toBeCloseTo(0.05 * Math.log(11), 4);
    expect(first.recency_boost).toBeGreaterThan(0);
    expect(first.final_score).toBeCloseTo(
      first.cosine + first.usage_boost + first.recency_boost,
      4,
    );
  });

  it("ties are stable by cosine when usage is equal", () => {
    const usageMap = new Map([
      ["a", stats(5, 1)],
      ["b", stats(5, 1)],
    ]);
    const out = rerank(
      [
        { skill_id: "a", cosine: 0.6 },
        { skill_id: "b", cosine: 0.5 },
      ],
      usageMap,
    );
    expect(out[0]?.skill_id).toBe("a");
  });

  it("recency tiebreaks two skills with same usage_count but different last_used", () => {
    const usageMap = new Map([
      ["recent", stats(10, 0)],   // used today
      ["stale",  stats(10, 30)],  // 30 days ago
    ]);
    const out = rerank(
      [
        { skill_id: "recent", cosine: 0.5 },
        { skill_id: "stale", cosine: 0.5 },
      ],
      usageMap,
    );
    expect(out[0]?.skill_id).toBe("recent");
  });
});
