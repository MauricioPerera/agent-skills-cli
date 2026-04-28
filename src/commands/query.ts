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

import type { FileBank, IndexedSkill } from "../lib/bank.js";
import type { EmbeddingProvider } from "../lib/embed.js";
import { CliError, EXIT } from "../lib/errors.js";
import { aggregateUsage, rerank, type RerankConfig } from "../lib/rerank.js";
import { checkApplicability, detectHost } from "../lib/applicable.js";

export interface QueryOptions {
  intent: string;
  k?: number;
  bank: FileBank;
  embedder: EmbeddingProvider;
  /** Apply audit-based rerank. Default: true. */
  rerank?: boolean;
  /** Drop skills failing applicable_when. Default: true. */
  filterApplicable?: boolean;
  /** Override rerank weights for testing or tuning. */
  rerankConfig?: RerankConfig;
}

export interface QueryHit {
  identity: string;
  title: string;
  use_when: string;
  /** The score used for ranking (cosine + boosts after rerank, or pure cosine). */
  score: number;
  /** Pure cosine similarity, always reported even if rerank applied. */
  cosine: number;
  /** Audit-derived usage count for this skill in the local bank. */
  usage_count: number;
  /** Boost applied to the score from usage_count (≥0). */
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
  rerank_applied: boolean;
  filter_applied: boolean;
  hits: QueryHit[];
  /** Skills that scored well but were filtered out by applicable_when. */
  filtered_out?: FilteredOut[];
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
  const rerankEnabled = opts.rerank !== false; // default on
  const filterEnabled = opts.filterApplicable !== false; // default on

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

  // 3. Optionally rerank using audit signals
  let scored: Array<{ skill: IndexedSkill; cosine: number; final: number; usage_count: number; usage_boost: number; recency_boost: number }>;
  if (rerankEnabled) {
    const auditEntries = await opts.bank.listAudit({});
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
    scored = applicable.map(({ skill, score }) => ({
      skill,
      cosine: score,
      final: score,
      usage_count: 0,
      usage_boost: 0,
      recency_boost: 0,
    }));
  }

  // 4. Trim to top-k for the agent
  const top = scored.slice(0, k);

  const result: QueryResult = {
    intent: opts.intent,
    embedding_model: meta.embedding_model,
    rerank_applied: rerankEnabled,
    filter_applied: filterEnabled,
    hits: top.map((h) => ({
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
    })),
  };

  if (filteredOut.length > 0) result.filtered_out = filteredOut;
  return result;
};

export const printQueryResult = (result: QueryResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`Top ${result.hits.length} skills for: "${result.intent}"\n`);
  process.stdout.write(`Embedding: ${result.embedding_model}`);
  const flags: string[] = [];
  if (result.rerank_applied) flags.push("rerank");
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
    if (result.rerank_applied && (hit.usage_count > 0 || hit.recency_boost > 0)) {
      process.stdout.write(
        `   Score breakdown: cosine=${hit.cosine.toFixed(3)} ` +
          `+ usage=${hit.usage_boost.toFixed(3)} (n=${hit.usage_count}) ` +
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
