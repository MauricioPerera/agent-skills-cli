// `agent-skills bench <truth-file> [flags]` — measure top-K retrieval accuracy
// against a ground-truth file of (intent, expected_skill_id) pairs.
//
// This converts the ad-hoc benchmarks in BENCHMARK.md into a reproducible
// command that any operator can run against their own bank, with their own
// embedding provider, and their own truth file. Same code path that produced
// the v0.4.0 / v0.5.0 / v0.6.0 numbers.
//
// Truth file formats accepted (auto-detected by first non-whitespace char):
//
//   JSONL (recommended for scale, append-friendly):
//     {"intent": "fetch a URL", "expected": "http-get"}
//     {"intent": "encode as base64", "expected": "base64-encode"}
//
//   JSON array (more readable for hand-editing):
//     [
//       { "intent": "fetch a URL", "expected": "http-get" },
//       { "intent": "encode as base64", "expected": "base64-encode" }
//     ]
//
// `expected` is the short skill id (e.g., "http-get") — the bench resolves
// it against the bank via findByShortId. Using short ids (not full identities)
// makes truth files portable across skill-pack revisions.

import { readFile } from "node:fs/promises";
import type { FileBank } from "../lib/bank.js";
import type { EmbeddingProvider } from "../lib/embed.js";
import { CliError, EXIT } from "../lib/errors.js";
import { runQuery, type RerankMode } from "./query.js";

export interface BenchTruthEntry {
  /** Natural-language query the agent would issue. */
  intent: string;
  /** Expected skill — the short id (frontmatter `id`), not the full identity. */
  expected: string;
}

export interface BenchOptions {
  /** Path to a JSON or JSONL truth file. */
  truthFile: string;
  bank: FileBank;
  embedder: EmbeddingProvider;
  /** Top-K to report. Default: 5. The bench measures top-1 through top-K. */
  k?: number;
  /** Same semantics as runQuery's rerankMode. Default: "intent-conditional". */
  rerankMode?: RerankMode;
  /** Whether applicable_when filtering is on. Default: true. */
  filterApplicable?: boolean;
}

export interface BenchQueryResult {
  intent: string;
  expected: string;
  /** 1-indexed rank of the expected skill in the result list, or null if outside top-K. */
  rank: number | null;
  /** Identity of what we ACTUALLY retrieved at top-1. */
  got_top1: string;
  /** Score of the top-1 hit. */
  top1_score: number;
  /** Score of the expected skill, if it was in the top-K. */
  expected_score: number | null;
  /** Margin between top-1 and top-2 (positive = top-1 wins by this much). */
  margin: number;
}

export interface BenchResult {
  truth_file: string;
  embedding_model: string;
  rerank_mode: RerankMode;
  filter_applied: boolean;
  k: number;
  /** Total queries in the truth file. */
  total: number;
  /** Number where the expected skill was at rank 1. */
  top1: number;
  /** Number where the expected skill was at rank ≤ 3. */
  top3: number;
  /** Number where the expected skill was at rank ≤ K. */
  topK: number;
  /** Mean of top1_score across all queries. */
  mean_top1_score: number;
  /** Mean of margin across all queries. Higher = more confident retrieval. */
  mean_margin: number;
  /** Every per-query result. */
  queries: BenchQueryResult[];
  /** Subset of queries where rank !== 1. */
  failures: BenchQueryResult[];
  /** Wall-clock duration. */
  elapsed_ms: number;
}

/**
 * Parse a truth file. Accepts JSONL (one object per line) or JSON array.
 * Detection: first non-whitespace char is `[` → JSON array, else JSONL.
 */
const parseTruthFile = (text: string, filePath: string): BenchTruthEntry[] => {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) {
    throw new CliError(EXIT.USAGE, `${filePath}: truth file is empty`);
  }

  let parsed: unknown[];
  if (trimmed[0] === "[") {
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) {
        throw new CliError(
          EXIT.USAGE,
          `${filePath}: top-level JSON value is not an array`,
        );
      }
      parsed = arr;
    } catch (err) {
      if (err instanceof CliError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(EXIT.USAGE, `${filePath}: invalid JSON: ${msg}`);
    }
  } else {
    // JSONL: parse line by line, skipping blanks and # comments
    parsed = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] as string).trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      try {
        parsed.push(JSON.parse(line));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          EXIT.USAGE,
          `${filePath}:${i + 1}: invalid JSON: ${msg}`,
        );
      }
    }
  }

  if (parsed.length === 0) {
    throw new CliError(EXIT.USAGE, `${filePath}: truth file contains no entries`);
  }

  const entries: BenchTruthEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (e === null || typeof e !== "object") {
      throw new CliError(
        EXIT.USAGE,
        `${filePath} entry #${i + 1}: expected object, got ${typeof e}`,
      );
    }
    const obj = e as Record<string, unknown>;
    const intent = obj["intent"];
    const expected = obj["expected"];
    if (typeof intent !== "string" || intent.length === 0) {
      throw new CliError(
        EXIT.USAGE,
        `${filePath} entry #${i + 1}: missing or empty 'intent' (string)`,
      );
    }
    if (typeof expected !== "string" || expected.length === 0) {
      throw new CliError(
        EXIT.USAGE,
        `${filePath} entry #${i + 1}: missing or empty 'expected' (short skill id, string)`,
      );
    }
    entries.push({ intent, expected });
  }
  return entries;
};

/**
 * Resolve expected short ids in the truth file to identities present in the
 * bank, validating that every expected skill is actually subscribed. We do
 * this BEFORE running queries so a typo in the truth file fails fast.
 */
const resolveExpectedIdentities = async (
  bank: FileBank,
  entries: readonly BenchTruthEntry[],
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const unique = new Set(entries.map((e) => e.expected));
  for (const shortId of unique) {
    const matches = await bank.findByShortId(shortId);
    if (matches.length === 0) {
      throw new CliError(
        EXIT.NOT_FOUND,
        `truth file references unknown skill id '${shortId}'. ` +
          `Run 'agent-skills sync ...' to install it, or fix the truth file.`,
      );
    }
    if (matches.length > 1) {
      const ids = matches.map((m) => m.identity).join("\n  - ");
      throw new CliError(
        EXIT.USAGE,
        `truth file id '${shortId}' is ambiguous; multiple skills match:\n  - ${ids}\n` +
          `Either uninstall the duplicates or change the truth file to use a full identity ` +
          `(future enhancement).`,
      );
    }
    out.set(shortId, (matches[0] as { identity: string }).identity);
  }
  return out;
};

export const runBench = async (opts: BenchOptions): Promise<BenchResult> => {
  const start = Date.now();
  const k = opts.k ?? 5;
  const rerankMode: RerankMode = opts.rerankMode ?? "intent-conditional";
  const filterApplicable = opts.filterApplicable !== false;

  // 1. Load + parse truth file.
  let text: string;
  try {
    text = await readFile(opts.truthFile, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.NOT_FOUND, `cannot read truth file: ${msg}`);
  }
  const entries = parseTruthFile(text, opts.truthFile);

  // 2. Resolve expected short ids → identities. Fails fast on bad references.
  const expectedIdentities = await resolveExpectedIdentities(opts.bank, entries);

  // 3. Run each query through the same code path that the production CLI uses.
  const queries: BenchQueryResult[] = [];
  let top1 = 0;
  let top3 = 0;
  let topK = 0;
  let totalTop1Score = 0;
  let totalMargin = 0;

  for (const entry of entries) {
    const expectedIdentity = expectedIdentities.get(entry.expected) as string;

    const result = await runQuery({
      intent: entry.intent,
      // Always retrieve at least k+1 to have a runner-up for margin computation,
      // and oversample to ensure rank info up to k is faithful even if filter drops items.
      k: Math.max(k + 1, 10),
      bank: opts.bank,
      embedder: opts.embedder,
      rerankMode,
      filterApplicable,
    });

    const hits = result.hits;
    const top1Hit = hits[0];
    const top2Hit = hits[1];
    const top1Score = top1Hit?.score ?? 0;
    const top2Score = top2Hit?.score ?? 0;
    const margin = top1Score - top2Score;

    // Find rank of the expected identity (1-indexed). null if outside top-K.
    let rank: number | null = null;
    let expectedScore: number | null = null;
    for (let i = 0; i < Math.min(hits.length, k); i++) {
      if (hits[i]?.identity === expectedIdentity) {
        rank = i + 1;
        expectedScore = hits[i]?.score ?? 0;
        break;
      }
    }

    queries.push({
      intent: entry.intent,
      expected: entry.expected,
      rank,
      got_top1: top1Hit?.identity ?? "",
      top1_score: top1Score,
      expected_score: expectedScore,
      margin,
    });

    if (rank === 1) top1++;
    if (rank !== null && rank <= 3) top3++;
    if (rank !== null) topK++;

    totalTop1Score += top1Score;
    totalMargin += margin;
  }

  const total = entries.length;
  const failures = queries.filter((q) => q.rank !== 1);

  return {
    truth_file: opts.truthFile,
    embedding_model: opts.embedder.name,
    rerank_mode: rerankMode,
    filter_applied: filterApplicable,
    k,
    total,
    top1,
    top3,
    topK,
    mean_top1_score: total > 0 ? totalTop1Score / total : 0,
    mean_margin: total > 0 ? totalMargin / total : 0,
    queries,
    failures,
    elapsed_ms: Date.now() - start,
  };
};

const pct = (num: number, denom: number): string =>
  denom === 0 ? "n/a" : `${((num / denom) * 100).toFixed(1)}%`;

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1) + "…";

export const printBenchResult = (result: BenchResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`Bench against ${result.total} queries\n`);
  process.stdout.write(`  truth: ${result.truth_file}\n`);
  process.stdout.write(`  model: ${result.embedding_model}`);
  process.stdout.write(` | rerank=${result.rerank_mode}`);
  if (result.filter_applied) process.stdout.write(" | filter=on");
  process.stdout.write(`\n\n`);

  process.stdout.write(`  top-1:  ${result.top1}/${result.total} (${pct(result.top1, result.total)})\n`);
  process.stdout.write(`  top-3:  ${result.top3}/${result.total} (${pct(result.top3, result.total)})\n`);
  if (result.k !== 3) {
    process.stdout.write(`  top-${result.k}:  ${result.topK}/${result.total} (${pct(result.topK, result.total)})\n`);
  }
  process.stdout.write(`  mean top-1 score:  ${result.mean_top1_score.toFixed(3)}\n`);
  process.stdout.write(`  mean margin (top-1 → top-2):  +${result.mean_margin.toFixed(3)}\n`);
  process.stdout.write(`  elapsed: ${result.elapsed_ms}ms\n`);

  if (result.failures.length > 0) {
    process.stdout.write(`\nFailures (${result.failures.length}):\n`);
    for (const f of result.failures) {
      const got = f.got_top1.split("/").pop() ?? f.got_top1;
      const rankStr = f.rank === null ? `>${result.k}` : String(f.rank);
      const expectedScore = f.expected_score === null ? "n/a" : f.expected_score.toFixed(3);
      process.stdout.write(
        `  ✗ "${truncate(f.intent, 60)}"\n` +
          `      expected: ${f.expected} (rank ${rankStr}, score ${expectedScore})\n` +
          `      got:      ${got} (score ${f.top1_score.toFixed(3)})\n`,
      );
    }
  } else {
    process.stdout.write(`\n✓ no failures\n`);
  }
};
