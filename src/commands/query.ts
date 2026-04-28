// `agent-skills query "<intent>" [--k N]` — embed the user's intent, run
// nearest-neighbor search over the local bank, return top-K skills.
//
// Per SPEC.md §4.3: the query embedding MUST use the same model that
// indexed the skills. The bank's metadata records the model name and
// the search code refuses if there's a mismatch.
//
// v0.4.0+ optionally:
//   - Filters out skills whose applicable_when isn't satisfied by the host.
//   - Re-ranks by audit-derived signals (usage_count + recency).

import type { AuditEntry, FileBank, IndexedSkill } from "../lib/bank.js";
import type { EmbeddingProvider } from "../lib/embed.js";
import { CliError, EXIT } from "../lib/errors.js";
import {
  aggregateUsage,
  intentConditionalRerank,
  rerank,
  type IntentConditionalConfig,
  type RerankConfig,
  type SkillIntentMap,
} from "../lib/rerank.js";
import { checkApplicability, detectHost } from "../lib/applicable.js";
import { IntentEmbeddingCache } from "../lib/intent-cache.js";
import { join } from "node:path";

/**
 * Rerank strategy.
 *
 *   - "global": cosine + α·log(1+global_usage_count) + β·recency.
 *               Simple, but vulnerable to concentrated usage (see v0.4.0
 *               BENCHMARK stress test).
 *
 *   - "intent-conditional": cosine + α·log(1+similar_past_intent_count)
 *               + β·recency_of_relevant_past. Past audit entries are filtered
 *               by intent similarity to the current query before counting.
 *               Robust against concentrated usage on unrelated tasks.
 *               (Default in v0.5.0+.)
 *
 *   - "none": pure cosine, no rerank.
 */
export type RerankMode = "global" | "intent-conditional" | "none";

export interface QueryOptions {
  intent: string;
  k?: number;
  bank: FileBank;
  embedder: EmbeddingProvider;
  /** Rerank strategy. Default: "intent-conditional". */
  rerankMode?: RerankMode;
  /** Drop skills failing applicable_when. Default: true. */
  filterApplicable?: boolean;
  /** Override rerank weights for testing or tuning. */
  rerankConfig?: RerankConfig | IntentConditionalConfig;
  /**
   * Backwards-compat shim for v0.4.0: if `rerank` is `false`, force
   * mode = "none". Internal code should prefer `rerankMode`.
   */
  rerank?: boolean;
  /**
   * Optional: scope intent-conditional rerank to past audits with this
   * tenant (v0.12.0+, SPEC §4.5.1). When set, only audit entries whose
   * `tenant` field equals this value contribute to the boost — multi-
   * tenant deployments avoid bleeding one user's history into another's
   * retrieval. When unset, all audit entries participate (single-user
   * default behaviour, unchanged from v0.11).
   */
  tenant?: string;
}

export interface QueryHit {
  identity: string;
  title: string;
  use_when: string;
  /** The score used for ranking (cosine + boosts after rerank, or pure cosine). */
  score: number;
  /** Pure cosine similarity, always reported even if rerank applied. */
  cosine: number;
  /** Total audit-derived usage count for this skill (across all intents). */
  usage_count: number;
  /** When mode = intent-conditional, the count after similarity filter. Else equals usage_count. */
  conditional_count?: number;
  /** Boost applied to the score from usage_count or conditional_count (≥0). */
  usage_boost: number;
  /** Boost applied from recency (0..β). */
  recency_boost: number;
  command_template: string;
  required_env?: string[];
  category?: string;
  tags?: string[];
  provenance: IndexedSkill["provenance"];
}

export interface FilteredOut {
  identity: string;
  title: string;
  reasons: string[];
}

export interface QueryResult {
  intent: string;
  embedding_model: string;
  rerank_mode: RerankMode;
  filter_applied: boolean;
  hits: QueryHit[];
  /** Skills that scored well but were filtered out by applicable_when. */
  filtered_out?: FilteredOut[];
  /** Backward-compat (deprecated v0.5.0): true iff rerank_mode != "none". */
  rerank_applied: boolean;
}

export const runQuery = async (opts: QueryOptions): Promise<QueryResult> => {
  if (opts.intent.trim().length === 0) {
    throw new CliError(EXIT.USAGE, "query: intent is empty");
  }

  // Verify the bank's embedding model matches the embedder we're using.
  const meta = await opts.bank.getMeta();
  if (meta === null) {
    throw new CliError(
      EXIT.NOT_FOUND,
      `bank is not initialized; run 'agent-skills sync <repo>' first`,
    );
  }
  if (meta.embedding_model !== opts.embedder.name) {
    throw new CliError(
      EXIT.VALIDATION,
      `embedding model mismatch: bank uses '${meta.embedding_model}' but query is using '${opts.embedder.name}'. Either reset the bank or use the matching embedder.`,
    );
  }

  const queryEmbedding = await opts.embedder.embed(opts.intent);

  if (queryEmbedding.length !== meta.embedding_dim) {
    throw new CliError(
      EXIT.VALIDATION,
      `query embedding dim ${queryEmbedding.length} != bank dim ${meta.embedding_dim}`,
    );
  }

  const k = opts.k ?? 5;
  const filterEnabled = opts.filterApplicable !== false; // default on

  // Determine rerank mode (with v0.4.0 backwards-compat shim)
  let mode: RerankMode = opts.rerankMode ?? "intent-conditional";
  if (opts.rerank === false) mode = "none"; // legacy --no-rerank flag

  // 1. Get a wider candidate set than k so filtering doesn't starve us
  const oversampleK = Math.max(k * 3, 10);
  const candidates = await opts.bank.search(queryEmbedding, oversampleK);

  // 2. Optionally filter by applicable_when
  const filteredOut: FilteredOut[] = [];
  let applicable = candidates;
  if (filterEnabled) {
    const host = detectHost();
    applicable = candidates.filter(({ skill }) => {
      const result = checkApplicability(skill.applicable_when, host);
      if (!result.applicable) {
        filteredOut.push({
          identity: skill.identity,
          title: skill.title,
          reasons: result.reasons,
        });
      }
      return result.applicable;
    });
  }

  // 3. Rerank by mode
  type Scored = {
    skill: IndexedSkill;
    cosine: number;
    final: number;
    usage_count: number;
    conditional_count?: number;
    usage_boost: number;
    recency_boost: number;
  };
  let scored: Scored[];

  if (mode === "none") {
    scored = applicable.map(({ skill, score }) => ({
      skill,
      cosine: score,
      final: score,
      usage_count: 0,
      usage_boost: 0,
      recency_boost: 0,
    }));
  } else if (mode === "global") {
    const allAudit = await opts.bank.listAudit({});
    // Tenant filter: when --tenant is set, only this tenant's audit
    // history contributes to the global boost. Same isolation guarantee
    // as the intent-conditional path.
    const auditEntries = opts.tenant !== undefined
      ? allAudit.filter((e) => e.tenant === opts.tenant)
      : allAudit;
    const usageStats = aggregateUsage(auditEntries);
    const reranked = rerank(
      applicable.map(({ skill, score }) => ({ skill_id: skill.identity, cosine: score })),
      usageStats,
      opts.rerankConfig ?? {},
    );
    const skillById = new Map(applicable.map(({ skill }) => [skill.identity, skill]));
    scored = reranked.map((r) => ({
      skill: skillById.get(r.skill_id) as IndexedSkill,
      cosine: r.cosine,
      final: r.final_score,
      usage_count: r.usage_count,
      usage_boost: r.usage_boost,
      recency_boost: r.recency_boost,
    }));
  } else {
    // intent-conditional
    scored = await runIntentConditional(opts, applicable, queryEmbedding);
  }

  // 4. Trim to top-k for the agent
  const top = scored.slice(0, k);

  const result: QueryResult = {
    intent: opts.intent,
    embedding_model: meta.embedding_model,
    rerank_mode: mode,
    rerank_applied: mode !== "none",
    filter_applied: filterEnabled,
    hits: top.map((h) => {
      const hit: QueryHit = {
        identity: h.skill.identity,
        title: h.skill.title,
        use_when: h.skill.use_when,
        score: h.final,
        cosine: h.cosine,
        usage_count: h.usage_count,
        usage_boost: h.usage_boost,
        recency_boost: h.recency_boost,
        command_template: h.skill.command_template,
        required_env: h.skill.required_env,
        category: h.skill.category,
        tags: h.skill.tags,
        provenance: h.skill.provenance,
      };
      if (h.conditional_count !== undefined) hit.conditional_count = h.conditional_count;
      return hit;
    }),
  };

  if (filteredOut.length > 0) result.filtered_out = filteredOut;
  return result;
};

/**
 * Helper: run intent-conditional rerank.
 *
 * Steps:
 *   1. Read all audit entries with an `intent` field.
 *   2. Group intents per skill_id.
 *   3. Embed each unique intent (cached in <bank>/intent-embeddings.json).
 *   4. Build SkillIntentMap and call intentConditionalRerank().
 *
 * Falls back to "global" mode if no audit history exists yet (cold start).
 */
const runIntentConditional = async (
  opts: QueryOptions,
  applicable: Array<{ skill: IndexedSkill; score: number }>,
  queryEmbedding: number[],
): Promise<Array<{
  skill: IndexedSkill;
  cosine: number;
  final: number;
  usage_count: number;
  conditional_count: number;
  usage_boost: number;
  recency_boost: number;
}>> => {
  const allAudit = await opts.bank.listAudit({});
  // Tenant filter (SPEC §4.5.1, v0.12.0+): when --tenant is set, only past
  // audits from this tenant participate. Otherwise (single-user default),
  // every entry participates exactly as in v0.11.
  const tenantScoped = opts.tenant !== undefined
    ? allAudit.filter((e) => e.tenant === opts.tenant)
    : allAudit;
  const audits = tenantScoped.filter((e): e is AuditEntry & { intent: string } =>
    typeof e.intent === "string" && e.intent.length > 0,
  );

  // Cold start: no audit data with intents → behaves like cosine-only
  if (audits.length === 0) {
    return applicable.map(({ skill, score }) => ({
      skill,
      cosine: score,
      final: score,
      usage_count: 0,
      conditional_count: 0,
      usage_boost: 0,
      recency_boost: 0,
    }));
  }

  // Build intent embedding cache
  const cachePath = join(opts.bank.root, "intent-embeddings.json");
  const cache = new IntentEmbeddingCache(cachePath, opts.embedder);

  // Embed all unique intents (cached). One batch.
  const uniqueIntents = Array.from(new Set(audits.map((e) => e.intent)));
  const embeddings = await cache.embedBatch(uniqueIntents);

  // Build per-skill intent map
  const perSkillIntents: SkillIntentMap = new Map();
  for (const audit of audits) {
    const vec = embeddings.get(audit.intent);
    if (vec === undefined) continue;
    const arr = perSkillIntents.get(audit.skill_id) ?? [];
    arr.push({ intent: audit.intent, vec, timestamp: audit.timestamp });
    perSkillIntents.set(audit.skill_id, arr);
  }

  const reranked = intentConditionalRerank(
    applicable.map(({ skill, score }) => ({ skill_id: skill.identity, cosine: score })),
    queryEmbedding,
    perSkillIntents,
    opts.rerankConfig ?? {},
  );

  const skillById = new Map(applicable.map(({ skill }) => [skill.identity, skill]));
  return reranked.map((r) => ({
    skill: skillById.get(r.skill_id) as IndexedSkill,
    cosine: r.cosine,
    final: r.final_score,
    usage_count: r.usage_count,
    conditional_count: r.conditional_count,
    usage_boost: r.usage_boost,
    recency_boost: r.recency_boost,
  }));
};

export const printQueryResult = (result: QueryResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`Top ${result.hits.length} skills for: "${result.intent}"\n`);
  process.stdout.write(`Embedding: ${result.embedding_model}`);
  const flags: string[] = [];
  if (result.rerank_mode !== "none") flags.push(`rerank=${result.rerank_mode}`);
  if (result.filter_applied) flags.push("filter");
  if (flags.length > 0) process.stdout.write(` | ${flags.join(" + ")}`);
  process.stdout.write("\n\n");

  if (result.hits.length === 0) {
    process.stdout.write("(no matching skills; run 'agent-skills sync' or check 'agent-skills list')\n");
    if (result.filtered_out && result.filtered_out.length > 0) {
      process.stdout.write(`\n${result.filtered_out.length} skill(s) filtered out by applicable_when:\n`);
      for (const f of result.filtered_out) {
        process.stdout.write(`  - ${f.identity}: ${f.reasons.join("; ")}\n`);
      }
    }
    return;
  }

  for (let i = 0; i < result.hits.length; i++) {
    const hit = result.hits[i] as QueryHit;
    process.stdout.write(`${i + 1}. [${hit.score.toFixed(3)}] ${hit.identity}\n`);
    process.stdout.write(`   Title: ${hit.title}\n`);
    process.stdout.write(`   Use when: ${hit.use_when}\n`);
    if (result.rerank_mode !== "none" && (hit.usage_count > 0 || hit.recency_boost > 0)) {
      const countLabel = result.rerank_mode === "intent-conditional"
        ? `n_relevant=${hit.conditional_count ?? 0}/${hit.usage_count}`
        : `n=${hit.usage_count}`;
      process.stdout.write(
        `   Score breakdown: cosine=${hit.cosine.toFixed(3)} ` +
          `+ usage=${hit.usage_boost.toFixed(3)} (${countLabel}) ` +
          `+ recency=${hit.recency_boost.toFixed(3)}\n`,
      );
    }
    if (hit.required_env && hit.required_env.length > 0) {
      process.stdout.write(`   Requires env: ${hit.required_env.join(", ")}\n`);
    }
    process.stdout.write("\n");
  }

  if (result.filtered_out && result.filtered_out.length > 0) {
    process.stdout.write(`Filtered out by applicable_when: ${result.filtered_out.length}\n`);
  }
};
