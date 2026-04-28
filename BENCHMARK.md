# Retrieval benchmark — agent-skills v0.1 + Cloudflare Workers AI

**TL;DR**: 7 / 7 agent intents matched their intended skill as the top-1 result against the public [`agent-skills-pack@v1.0.0`](https://github.com/MauricioPerera/agent-skills-pack) corpus, embedded with `@cf/baai/bge-base-en-v1.5` (768-dim) on Cloudflare Workers AI.

This is an end-to-end empirical validation that the agent-skills retrieval design works in practice with off-the-shelf components.

## Setup

- **Skill corpus**: `agent-skills-pack@v1.0.0` (commit `cc7eb3c0`) — 7 production-ready skills.
- **Embedding model**: `@cf/baai/bge-base-en-v1.5` via Cloudflare Workers AI REST API.
- **Embedding-text composition**: per [SPEC §4.2](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md#42-embedding-text-composition) — `title . use_when . description . examples[].intent . tags`.
- **Search method**: brute-force cosine similarity over the 7 stored vectors.
- **Date**: 2026-04-28.

## Results

| Agent intent | Top-1 (expected) | Top-1 score | Margin to Top-2 |
|---|---|---:|---:|
| "I need to fetch the contents of a webpage" | **http-get** ✓ | 0.7373 | +0.095 |
| "How do I file a bug report on GitHub?" | **github-issue-create** ✓ | 0.7636 | +0.171 |
| "encode this auth header to base64" | **base64-encode** ✓ | 0.8267 | +0.209 |
| "search the codebase for TODO comments" | **ripgrep-search** ✓ | 0.7374 | +0.132 |
| "extract names from a JSON file" | **json-query** ✓ | 0.6958 | +0.124 |
| "read the first 100 lines of /etc/hosts" | **read-file** ✓ | 0.6784 | +0.058 |
| "post some JSON to a webhook" | **http-post-json** ✓ | 0.7741 | +0.147 |

- **Top-1 accuracy: 7 / 7 (100 %)**.
- **Mean top-1 score**: 0.745.
- **Mean margin top-1 → top-2**: 0.134 — the embeddings genuinely discriminate; the ranking is not razor-thin.

## Why this matters

This is the empirical answer to "but does retrieval-over-injection actually work?"

- The agent doesn't need to know any tool catalog upfront.
- Each agent emits an intent in plain natural language ("how do I file a bug report").
- A 768-dim embedding from a free-tier model is enough to find the right SKILL.md among the candidates.
- Score margins are wide enough that re-ranking isn't strictly necessary for this corpus — top-1 is the right call.

It also validates the [SPEC §4.2](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md#42-embedding-text-composition) embedding-text recipe: composing `title + use_when + description + examples + tags` into one input gives the embedding model enough surface area to capture each skill's intent space.

## Reproducing

End-to-end with the published CLI:

```bash
# Setup
export CF_ACCOUNT_ID=<32-hex-account-id>
export CF_API_TOKEN=<token-with-Workers-AI-permission>

# Sync the public skill pack
agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0

# Each of the 7 intents should return its expected skill as top-1
for intent in \
  "I need to fetch the contents of a webpage" \
  "How do I file a bug report on GitHub?" \
  "encode this auth header to base64" \
  "search the codebase for TODO comments" \
  "extract names from a JSON file" \
  "read the first 100 lines of /etc/hosts" \
  "post some JSON to a webhook"; do
  echo "─── $intent ───"
  agent-skills query "$intent" --k 1 --json | jq '.hits[0] | {identity, score}'
done
```

The CLI's underlying logic (resolve → fetch → parse → validate → embed → store → cosine search) is identical to the procedure that produced the table above.

## Caveats

- **Single embedding model evaluated.** Other models (`bge-large`, `bge-m3`, `embeddinggemma`) may give different absolute scores; the spec is model-agnostic but a bank cannot mix models in one index.
- **English corpus.** All 7 SKILL.md files are written in English. For a non-English corpus, evaluate `bge-m3` (multilingual, 1024-dim).
- **Small N (7 skills, 7 queries).** Real banks will have hundreds of skills; the per-intent score absolutes will compress, but the relative ranking should still place the intended skill at top-1 in most cases. Re-ranking by `usage_count` / `avg_rating` (per [SPEC §4.3](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md#43-retrieval-contract)) becomes more important as catalogs grow.
- **No paraphrasing test.** Each intent was hand-crafted to be plausible-but-not-identical to the skill's `use_when` field. A more rigorous benchmark would generate paraphrases at scale and measure top-K recall instead of point-estimate top-1.

## Future work

- Run the same benchmark across all 5 supported Cloudflare embedding models, compare ranking quality and cost.
- Add a `bench` subcommand to the CLI that runs a configurable intent → expected-skill ground truth file and reports accuracy + score gap stats.
- Compare brute-force cosine vs IVF-style ANN search at 1K / 10K / 100K skill scale.
