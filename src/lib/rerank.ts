// Rerank by audit signals.
//
// SPEC §4.3 says banks MAY re-rank by usage_count, avg_rating, or other
// secondary signals on top of cosine. This module implements a simple,
// transparent blend that runs over the local audit log:
//
//   final_score = cosine
//                + α × log(1 + usage_count)
//                + β × recency_boost
//
// Where:
//   - usage_count = number of audit entries for this skill_id (success or fail)
//   - recency_boost = 1.0 if used within last 24h, decaying to 0 over 30 days
//
// Defaults (α = 0.05, β = 0.03) are chosen so:
//   - A skill used 100× gets a +0.23 boost (log(101) × 0.05).
//   - The cosine margin between top-1 and top-2 is typically +0.10 to +0.15
//     (per BENCHMARK.md), so usage signals can shift rankings only when they
//     have substantial historical evidence.
//   - Recency adds at most +0.03, breaking ties between two equally-used skills.

import type { AuditEntry } from "./bank.js";

export interface RerankConfig {
  /** Weight on log(1 + usage_count). Default: 0.05. Set to 0 to disable usage boost. */
  alpha?: number;
  /** Weight on recency factor (0..1). Default: 0.03. Set to 0 to disable recency boost. */
  beta?: number;
  /** Half-life of recency in days. Default: 7 (i.e., 7-day-old usage gets half the boost). */
  recencyHalfLifeDays?: number;
}

const DEFAULT_ALPHA = 0.05;
const DEFAULT_BETA = 0.03;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 7;

export interface SkillUsageStats {
  /** Total number of audit entries (success + fail) for this skill identity. */
  count: number;
  /** Subset of count where exit_code === 0. */
  success_count: number;
  /** ISO timestamp of the most recent entry, or null if never used. */
  last_used: string | null;
}

/**
 * Aggregate audit entries into per-skill usage stats.
 */
export const aggregateUsage = (entries: AuditEntry[]): Map<string, SkillUsageStats> => {
  const map = new Map<string, SkillUsageStats>();
  for (const e of entries) {
    const existing = map.get(e.skill_id) ?? { count: 0, success_count: 0, last_used: null };
    existing.count += 1;
    if (e.exit_code === 0) existing.success_count += 1;
    if (existing.last_used === null || e.timestamp > existing.last_used) {
      existing.last_used = e.timestamp;
    }
    map.set(e.skill_id, existing);
  }
  return map;
};

/**
 * Compute the recency boost for a skill, given its last-used timestamp.
 * Returns a value in [0, 1].
 */
export const computeRecency = (
  lastUsed: string | null,
  nowIso: string,
  halfLifeDays = DEFAULT_RECENCY_HALF_LIFE_DAYS,
): number => {
  if (lastUsed === null) return 0;
  const ageMs = Date.parse(nowIso) - Date.parse(lastUsed);
  if (Number.isNaN(ageMs) || ageMs < 0) return 0;
  const ageDays = ageMs / 86400000;
  // Exponential decay: 2^(-age/halfLife). 0 days → 1.0, halfLife days → 0.5.
  return Math.pow(2, -ageDays / halfLifeDays);
};

/**
 * Apply the rerank blend to a list of (skill_id, cosine_score) tuples.
 * Returns the same list with `final_score` and a breakdown for transparency.
 */
export interface RerankInput {
  skill_id: string;
  cosine: number;
}

export interface RerankOutput {
  skill_id: string;
  cosine: number;
  usage_count: number;
  recency_boost: number;
  usage_boost: number;
  final_score: number;
}

export const rerank = (
  candidates: RerankInput[],
  usageStats: Map<string, SkillUsageStats>,
  config: RerankConfig = {},
  nowIso: string = new Date().toISOString(),
): RerankOutput[] => {
  const alpha = config.alpha ?? DEFAULT_ALPHA;
  const beta = config.beta ?? DEFAULT_BETA;
  const halfLifeDays = config.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;

  const out: RerankOutput[] = candidates.map((c) => {
    const stats = usageStats.get(c.skill_id) ?? {
      count: 0,
      success_count: 0,
      last_used: null,
    };
    const usage_boost = alpha * Math.log(1 + stats.count);
    const recency_boost = beta * computeRecency(stats.last_used, nowIso, halfLifeDays);
    const final_score = c.cosine + usage_boost + recency_boost;
    return {
      skill_id: c.skill_id,
      cosine: c.cosine,
      usage_count: stats.count,
      recency_boost,
      usage_boost,
      final_score,
    };
  });

  out.sort((a, b) => b.final_score - a.final_score);
  return out;
};
