// `agent-skills query "<intent>" [--k N]` — embed the user's intent, run
// nearest-neighbor search over the local bank, return top-K skills.
//
// Per SPEC.md §4.3: the query embedding MUST use the same model that
// indexed the skills. The bank's metadata records the model name and
// the search code refuses if there's a mismatch.

import type { FileBank, IndexedSkill } from "../lib/bank.js";
import type { EmbeddingProvider } from "../lib/embed.js";
import { CliError, EXIT } from "../lib/errors.js";

export interface QueryOptions {
  intent: string;
  k?: number;
  bank: FileBank;
  embedder: EmbeddingProvider;
}

export interface QueryHit {
  identity: string;
  title: string;
  use_when: string;
  score: number;
  command_template: string;
  required_env?: string[];
  category?: string;
  tags?: string[];
  provenance: IndexedSkill["provenance"];
}

export interface QueryResult {
  intent: string;
  embedding_model: string;
  hits: QueryHit[];
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
  const hits = await opts.bank.search(queryEmbedding, k);

  return {
    intent: opts.intent,
    embedding_model: meta.embedding_model,
    hits: hits.map(({ skill, score }) => ({
      identity: skill.identity,
      title: skill.title,
      use_when: skill.use_when,
      score,
      command_template: skill.command_template,
      required_env: skill.required_env,
      category: skill.category,
      tags: skill.tags,
      provenance: skill.provenance,
    })),
  };
};

export const printQueryResult = (result: QueryResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`Top ${result.hits.length} skills for: "${result.intent}"\n`);
  process.stdout.write(`Embedding model: ${result.embedding_model}\n\n`);

  if (result.hits.length === 0) {
    process.stdout.write("(no skills indexed; run 'agent-skills sync' first)\n");
    return;
  }

  for (let i = 0; i < result.hits.length; i++) {
    const hit = result.hits[i] as QueryHit;
    process.stdout.write(`${i + 1}. [${hit.score.toFixed(3)}] ${hit.identity}\n`);
    process.stdout.write(`   Title: ${hit.title}\n`);
    process.stdout.write(`   Use when: ${hit.use_when}\n`);
    if (hit.required_env && hit.required_env.length > 0) {
      process.stdout.write(`   Requires env: ${hit.required_env.join(", ")}\n`);
    }
    process.stdout.write("\n");
  }
};
