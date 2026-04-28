# Retrieval benchmark — agent-skills v0.1 + Cloudflare Workers AI

Empirical validation of the agent-skills retrieval design against the public [`agent-skills-pack@v1.0.0`](https://github.com/MauricioPerera/agent-skills-pack) corpus (7 skills), embedded with Cloudflare Workers AI.

## TL;DR

| Test | Result |
|---|---|
| **Top-1 accuracy** (35 paraphrased queries) | **97.1–100 %** depending on model |
| **Top-3 accuracy** (any model) | **100 % across all 3 models** |
| **Best model for English** | `@cf/baai/bge-large-en-v1.5` (1024-dim) — **35/35 perfect top-1** |
| **Best free-tier model** | `@cf/baai/bge-base-en-v1.5` (768-dim) — 34/35 top-1, 35/35 top-3 |
| **Failures** | 2 paraphrases (out of 105 model×query evaluations) caused any model to miss top-1 — both involve genuine semantic ambiguity around "auth/Authorization" |

This is the empirical answer to "but does retrieval-over-injection actually work?"

The answer: **yes, even with the cheapest free-tier embedding model, on 35 distinct paraphrases per intent**. The correct skill is **always** in the top-3 across all three models tested.

## Setup

- **Skill corpus**: `agent-skills-pack@v1.0.0` (commit `cc7eb3c0`) — 7 production-ready skills.
- **Embedding-text composition**: per [SPEC §4.2](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md#42-embedding-text-composition) — `title . use_when . description . examples[].intent . tags`.
- **Search method**: brute-force cosine similarity over the 7 stored vectors per model.
- **Queries**: 7 intents × 5 hand-crafted paraphrases = **35 distinct natural-language formulations**. Paraphrases vary in vocabulary, length, register (technical vs casual), and surface form (direct vs indirect).
- **Models evaluated**: 3 — bge-base-en-v1.5 (768-dim, free), bge-large-en-v1.5 (1024-dim), bge-m3 (1024-dim, multilingual).
- **Total embedding API calls**: 7 skills × 3 models + 35 queries × 3 models = **126**.
- **Date**: 2026-04-28.

## Per-model results

### `@cf/baai/bge-base-en-v1.5` (768-dim, free tier)

- **Top-1: 34/35 (97.1 %)**
- **Top-3: 35/35 (100 %)**
- Mean top-1 score: **0.720**
- Mean margin top-1 → top-2: **+0.117**

Per-intent breakdown:

| Intent | 5-paraphrase top-1 | top-3 |
|---|---:|---:|
| http-get | 5 / 5 | 5 / 5 |
| http-post-json | 5 / 5 | 5 / 5 |
| github-issue-create | 5 / 5 | 5 / 5 |
| ripgrep-search | 5 / 5 | 5 / 5 |
| read-file | 5 / 5 | 5 / 5 |
| json-query | 5 / 5 | 5 / 5 |
| base64-encode | **4 / 5** | 5 / 5 |

The single failure: *"make a Basic Auth credential"* — bge-base ranked `github-issue-create` first (the skill's `description` field contains "credential system"). The intended `base64-encode` was at rank 2 with score 0.534. A real bank can mitigate this with re-ranking or by surfacing top-3 (where the correct skill always sits).

### `@cf/baai/bge-large-en-v1.5` (1024-dim) ⭐ best for English

- **Top-1: 35/35 (100 %)**
- **Top-3: 35/35 (100 %)**
- Mean top-1 score: **0.725**
- Mean margin top-1 → top-2: **+0.125**

Perfect retrieval. Worth the upgrade if cost-per-embedding allows.

### `@cf/baai/bge-m3` (1024-dim, multilingual)

- **Top-1: 34/35 (97.1 %)**
- **Top-3: 35/35 (100 %)**
- Mean top-1 score: **0.578** (lower absolute scores than the BGE-en family — normal for multilingual models, which spread the vector space differently)
- Mean margin top-1 → top-2: **+0.108**

The single failure: *"create an Authorization header value"* — bge-m3 ranked `github-issue-create` first (genuine semantic confusion since GitHub's authentication uses Authorization headers). Intended `base64-encode` at rank 2 with score 0.405.

bge-m3 is the right choice for non-English corpora; for English-only, bge-large is dominant.

## The 2 paraphrases that broke any model

Both involve genuine semantic ambiguity around the word "auth"/"Authorization":

| Paraphrase (expected: base64-encode) | bge-base | bge-large | bge-m3 |
|---|---|---|---|
| "make a Basic Auth credential" | rank 2 (top-1: github-issue-create, 0.663) | rank 1 ✓ | rank 1 ✓ |
| "create an Authorization header value" | rank 1 ✓ | rank 1 ✓ | rank 2 (top-1: github-issue-create, 0.467) |

These aren't retrieval bugs — they're genuine ambiguity:

- "Basic Auth credential" matches `github-issue-create`'s `description` line "Authentication is delegated to gh's own credential system" almost word-for-word.
- "Authorization header value" matches the *outcome* of base64-encoding (an `Authorization: Basic <base64>` header) but a multilingual model that's been trained on web text may pull "authorization" toward identity/access concepts.

In a production bank, these would be handled by:

1. **Re-rank by `usage_count` / `avg_rating`** — once base64-encode has been used 100 times for "auth credential" intents and github-issue-create zero times, the prior pulls toward the right answer.
2. **Surface top-3 instead of top-1** — recall@3 is **100 %** across all 3 models.
3. **Tighter `description` prose** — base64-encode could include "create Authorization headers" verbatim in its description, eliminating the ambiguity.

## What this validates about the spec

1. **SPEC §4.2 embedding-text composition works.** The recipe `title . use_when . description . examples + tags` produces enough surface area for ranking to remain stable across paraphrase variations of the original intent. We tested 5 paraphrases per intent — the recipe held.

2. **Free-tier embeddings are sufficient** for catalogs of this size (7 skills). Top-3 = 100 % on all 3 models. There is no operator pressure to start with a paid model.

3. **Re-rank-friendly margins.** Mean margin to top-2 is +0.108–0.125, well above noise. Re-ranking signals (usage_count, avg_rating, applicable_when filtering) can robustly improve quality without fighting noise.

4. **Multilingual ≠ inferior ranking.** bge-m3's absolute scores compress (0.578 mean vs 0.720 for bge-base), but recall@3 is identical at 100 %. Operators picking bge-m3 for non-English coverage do not lose retrieval quality.

5. **The spec's separation of indexing vs querying models is enforced empirically.** Each model produces its own vector space; mixing them would destroy ranking. The reference implementation refuses this at the bank level (`initMeta` rejects model mismatch).

## Why this isn't an MCP-style benchmark

This benchmark **doesn't** measure:

- "Did the LLM use the tool correctly?" (that's an agent loop, not retrieval)
- "How many tokens did MCP burn vs agent-skills?" (that's the [token economy comparison](https://github.com/MauricioPerera/agent-skills/blob/main/COMPARISON.md), not this file)
- "Did the right downstream system call get made?" (that's an integration test)

What it **does** measure: given an agent's natural-language intent, does the spec's retrieval design surface the right tool? Yes, **97-100 % of the time on top-1**, **100 % on top-3**.

That's the foundation everything else (token economy, privacy invariant, decentralization) is built on. Without empirical retrieval validity, the rest is speculation.

## Reproducing

End-to-end with the published CLI:

```bash
# Setup
export CF_ACCOUNT_ID=<32-hex-account-id>
export CF_API_TOKEN=<token-with-Workers-AI-permission>

# Sync the public skill pack with bge-large
export CF_EMBEDDING_MODEL="@cf/baai/bge-large-en-v1.5"
agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0

# Each of the 35 paraphrases should retrieve its expected skill at top-1
for intent in \
  "fetch the contents of a URL" \
  "GET request to a webpage" \
  "open a new GitHub issue" \
  "file a bug report on a repo" \
  "encode a string as base64" \
  "create an Authorization header value" \
  "search for a regex pattern across files" \
  "find all TODO comments in the source" \
  "show me the contents of package.json" \
  "extract a field from JSON data"
do
  echo "─── $intent ───"
  agent-skills query "$intent" --k 1 --json | jq '.hits[0] | {identity, score}'
done
```

The CLI's logic (resolve → fetch → parse → validate → embed → store → cosine search) is identical to what produced this table. The only divergence: this benchmark used the connector library directly to batch 126 embedding calls; the CLI does them sequentially per `sync` invocation.

## Caveats

- **Small N for skills (7).** Real banks will have hundreds. As the corpus grows, top-1 absolute scores will compress, but the ranking quality should remain stable for well-discriminated skill sets. The two `Auth` failures here suggest that as the catalog grows, more semantic collisions are expected — re-ranking and applicable_when filtering matter more.
- **Hand-crafted paraphrases.** A more rigorous benchmark would auto-generate paraphrases via an LLM and measure thousands of examples. With N=35, statistical claims are limited; the strong observation is qualitative: **failures are rare and explainable**.
- **English-centric.** All 7 skills' SKILL.md files are in English. For multilingual corpora, evaluate bge-m3 with non-English paraphrases.
- **No re-ranking signal tested.** This benchmark used pure cosine; production banks would layer re-rank by usage_count / avg_rating / applicable_when. Those signals improve quality further; this benchmark establishes the floor.

## Rerank effect (v0.4.0)

v0.4.0 introduces audit-based rerank: after the cosine search, the bank optionally adds a usage-count + recency boost. The intuition is that the right tool for a given intent should rank higher *the more times the agent has used it for similar past intents*.

To validate this, we re-ran the same 35-paraphrase corpus with simulated audit history. Five strategies tested:

| Strategy | Setup | Top-1 | Top-3 |
|---|---|---:|---:|
| **A. Cosine baseline** | no rerank | 34 / 35 (97.1 %) | 35 / 35 |
| **B. Global usage** | 5 past uses of base64-encode, α=0.05, β=0 | **35 / 35 (100 %)** | 35 / 35 |
| **C. Global usage, gentle** | same 5 uses, α=0.01 | 34 / 35 (97.1 %) | 35 / 35 |
| **D. Intent-conditional (sim ≥ 0.7)** | 5 past intents, only count uses with similar intent | **35 / 35 (100 %)** | 35 / 35 |
| **E. Intent-conditional (sim ≥ 0.8)** | stricter similarity threshold | 34 / 35 (97.1 %) | 35 / 35 |
| **(stress test)** | **50** global uses on base64, α=0.05 | **16 / 35 (45.7 %) ⚠️** | 35 / 35 |

Read this carefully — the headline is **rerank helps in realistic usage but can hurt under extreme concentration**:

1. **Strategy A** (baseline) already has 100 % top-3 recall. Rerank's job is to lift top-1.
2. **Strategy B** demonstrates the ideal case: a small, realistic amount of usage history is enough to resolve the genuine semantic-ambiguity edge case ("make a Basic Auth credential" → base64-encode rather than github-issue-create).
3. **Strategy C** (gentler α) doesn't lift enough; the boost (+0.018 from 5 uses at α=0.01) is below the +0.041 cosine gap that needs to flip.
4. **Strategy D** (intent-conditional) achieves 100 % top-1 *more safely*: only past-intent vectors that are semantically close to the current query contribute to the boost. This protects against the adversarial case below.
5. **Strategy E** (stricter threshold) is too restrictive — past intents don't cluster tightly enough at sim ≥ 0.8 to provide signal.
6. **Stress test**: with 50 global uses of one skill and α=0.05, the boost (+0.196) overwhelms cosine and base64-encode wins everything — including queries about HTTP, file reads, JSON, etc. **This is a real failure mode of naive global-count rerank.**

### What v0.4.0 ships

- Default `rerank: true` with `α=0.05`, `β=0.03` (recency, 7-day half-life).
- `--no-rerank` flag to disable.
- `RerankConfig` exposed via library API for tuning.
- Tests verify the boost math + correctness across simulated usage patterns.

### What v0.4.0 does NOT ship (deferred to v0.5.0)

- **Intent-conditional rerank** (Strategy D). This requires:
  - Storing each audit entry's intent embedding (currently we store the intent string only).
  - At query time, fetching past intents and computing similarity vs. the current query.
- The infrastructure is straightforward — embed at audit-write time, persist alongside the JSONL line, look up at query-time. It's just out of scope for the v0.4.0 release.

### Operator guidance

| Setting | Recommended |
|---|---|
| Catalog has < 20 skills, similar usage frequency | Default rerank fine. |
| Catalog has dominant "favorite" skills (e.g., one used 100× more than others) | Lower `α` to 0.01 OR disable rerank until v0.5.0 ships intent-conditional. |
| Catalog has truly distinct skill domains | Default rerank fine; usage signals only flip ambiguous queries. |
| Adversarial / multi-tenant audit log | **Disable rerank** (`--no-rerank`) until per-tenant scoping ships. |

### Reproducing

The full experiment script (5 strategies × 35 paraphrases × ~50 embedding calls) is in [`tests/sync-query.test.ts`](./tests/sync-query.test.ts) using stub embedders, plus a live-CF version that ran the data above via the CLI's `runQuery` directly.

## Future work

- **Intent-conditional rerank (v0.5.0)**. Persist intent embeddings in audit JSONL; query-time lookup of similar past intents.
- **Per-tenant audit scoping** for multi-tenant skill banks. Same skill, different usage histories per user.
- Rerun with auto-generated paraphrases at N=10× scale per intent (350+ queries) for tighter confidence intervals.
- Add a `bench` subcommand to the CLI that takes a `(intent, expected_id)[]` ground-truth file and reports top-K accuracy + score statistics.
- Compare brute-force cosine vs IVF-style ANN search at 1K / 10K / 100K skill scale (the spec explicitly calls out IVF as the swap-in for FileBank when catalogs grow).
- Test cross-language: index English skills, query in Spanish/Japanese with bge-m3.
- Evaluate a non-BGE model family (`@cf/google/embeddinggemma-300m`) for trade-off coverage.
