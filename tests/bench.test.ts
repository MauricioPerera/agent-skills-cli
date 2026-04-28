// Tests for `agent-skills bench` (v0.7.0).
//
// We populate a tiny bank with the stub embedder and a hand-crafted truth file
// so cosine similarity is deterministic, then exercise:
//   - JSONL and JSON-array truth file formats
//   - Happy path (all queries land at top-1)
//   - Failure path (an intent that doesn't match the expected skill)
//   - Truth-file validation (typos, missing skills, malformed JSON)
//   - Aggregate stats correctness (top1, top3, mean margin, mean score)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBank, type IndexedSkill } from "../src/lib/bank.js";
import { createStubEmbedder } from "../src/lib/embed.js";
import { runBench } from "../src/commands/bench.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-bench-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const buildSkill = (
  id: string,
  embedding: number[],
  embedder: { name: string },
): IndexedSkill => ({
  identity: `github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/${id}`,
  schema_version: "0.1",
  id,
  version: "1.0.0",
  title: `Skill ${id}`,
  description: `Skill ${id} description`,
  use_when: `you want ${id}`,
  command_template: `echo {x}`,
  args: { x: { type: "string" } },
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "unsigned",
  },
  embedding,
  embedding_model: embedder.name,
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
});

// Helper: orthogonal-like vectors so each "query" deterministically picks ONE skill.
const oneHot = (i: number, dim: number): number[] => {
  const v = new Array<number>(dim).fill(0.01);
  v[i % dim] = 1;
  return v;
};

const setupBank = async (): Promise<{
  bank: FileBank;
  embedder: ReturnType<typeof createStubEmbedder>;
}> => {
  const bank = new FileBank({ rootDir: tmpDir });
  const dim = 32;
  const embedder = createStubEmbedder(dim);
  await bank.initMeta({ embedding_model: embedder.name, embedding_dim: dim });

  // 4 skills, each pinned to a different one-hot vector. The stub embedder
  // hashes text into a vector, so we override the bank's stored embeddings
  // with one-hot vectors for deterministic ranking.
  await bank.upsertSkill(buildSkill("alpha", oneHot(0, dim), embedder));
  await bank.upsertSkill(buildSkill("bravo", oneHot(1, dim), embedder));
  await bank.upsertSkill(buildSkill("charlie", oneHot(2, dim), embedder));
  await bank.upsertSkill(buildSkill("delta", oneHot(3, dim), embedder));
  return { bank, embedder };
};

describe("runBench — happy path", () => {
  it("reports top-1 = total when every query embeds closer to its expected skill", async () => {
    const { bank, embedder } = await setupBank();

    // Each "intent" hashes to SOME vector. With a stub embedder, the only way
    // to predict ranking is to make the bank's stored skill vectors uniquely
    // close to the embedded intent. Trick: we override one bank skill so its
    // stored embedding equals what the embedder produces for the intent string.
    // To do that without rebuilding the embedder: stash the EMBEDDED query
    // vector directly into the corresponding skill record.
    const intents = [
      { intent: "intent for alpha skill", expected: "alpha" },
      { intent: "intent for bravo skill", expected: "bravo" },
      { intent: "intent for charlie skill", expected: "charlie" },
    ];
    for (const t of intents) {
      const v = await embedder.embed(t.intent);
      const skill = await bank.getSkill(
        `github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/${t.expected}`,
      );
      if (skill === null) throw new Error("setup: skill not found");
      skill.embedding = v;
      await bank.upsertSkill(skill);
    }

    // Truth file as JSONL
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      intents.map((t) => JSON.stringify(t)).join("\n") + "\n",
      "utf8",
    );

    const result = await runBench({
      truthFile: truthPath,
      bank,
      embedder,
      rerankMode: "none",
    });

    expect(result.total).toBe(3);
    expect(result.top1).toBe(3);
    expect(result.top3).toBe(3);
    expect(result.failures).toEqual([]);
    expect(result.mean_top1_score).toBeGreaterThan(0.5);
    expect(result.mean_margin).toBeGreaterThan(0);
    expect(result.embedding_model).toBe(embedder.name);
    expect(result.rerank_mode).toBe("none");
  });

  it("accepts JSON array format too", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.json");
    await writeFile(
      truthPath,
      JSON.stringify(
        [
          { intent: "anything 1", expected: "alpha" },
          { intent: "anything 2", expected: "bravo" },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const result = await runBench({
      truthFile: truthPath,
      bank,
      embedder,
      rerankMode: "none",
    });
    expect(result.total).toBe(2);
    expect(result.queries).toHaveLength(2);
  });

  it("strips JSONL # comment lines", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      [
        "# This is a comment",
        '{"intent":"x","expected":"alpha"}',
        "",
        "# another",
        '{"intent":"y","expected":"bravo"}',
      ].join("\n"),
      "utf8",
    );

    const result = await runBench({ truthFile: truthPath, bank, embedder, rerankMode: "none" });
    expect(result.total).toBe(2);
  });
});

describe("runBench — failure path", () => {
  it("records mismatches in failures[] with correct rank info", async () => {
    const { bank, embedder } = await setupBank();
    // Don't override skill embeddings — the stub will hash each intent into
    // a near-random one-hot, so most won't match the expected skill.
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      [
        { intent: "alpha-q", expected: "alpha" },
        { intent: "bravo-q", expected: "bravo" },
      ]
        .map((t) => JSON.stringify(t))
        .join("\n"),
      "utf8",
    );

    const result = await runBench({ truthFile: truthPath, bank, embedder, rerankMode: "none" });

    // Whatever the stub picks, at least one of these probably misses, but we
    // can't assert the exact count — instead, assert structural properties:
    expect(result.total).toBe(2);
    expect(result.top1 + result.failures.length).toBe(result.total);
    for (const f of result.failures) {
      expect(f.rank === null || f.rank > 1).toBe(true);
      expect(f.got_top1).toBeTruthy();
      expect(f.top1_score).toBeGreaterThan(-1);
      expect(f.top1_score).toBeLessThanOrEqual(1);
    }
    for (const q of result.queries) {
      expect(q.margin).toBeGreaterThanOrEqual(0); // top1 ≥ top2 always
    }
  });
});

describe("runBench — truth file validation", () => {
  it("fails fast on truth file that references an unknown skill id", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      JSON.stringify({ intent: "x", expected: "does-not-exist" }) + "\n",
      "utf8",
    );

    await expect(
      runBench({ truthFile: truthPath, bank, embedder }),
    ).rejects.toThrow(/unknown skill id 'does-not-exist'/);
  });

  it("fails on missing 'intent' or 'expected' field", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(truthPath, JSON.stringify({ intent: "x" }) + "\n", "utf8");

    await expect(
      runBench({ truthFile: truthPath, bank, embedder }),
    ).rejects.toThrow(/'expected'/);
  });

  it("fails on malformed JSONL with line number", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      [
        '{"intent":"a","expected":"alpha"}',
        "{not json",
      ].join("\n"),
      "utf8",
    );

    await expect(
      runBench({ truthFile: truthPath, bank, embedder }),
    ).rejects.toThrow(/:2:.*invalid JSON/);
  });

  it("fails on empty truth file", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "empty.jsonl");
    await writeFile(truthPath, "", "utf8");

    await expect(
      runBench({ truthFile: truthPath, bank, embedder }),
    ).rejects.toThrow(/empty/);
  });

  it("fails on file that doesn't exist", async () => {
    const { bank, embedder } = await setupBank();
    await expect(
      runBench({ truthFile: join(tmpDir, "missing.jsonl"), bank, embedder }),
    ).rejects.toThrow(/cannot read truth file/);
  });

  it("fails on JSON array containing a non-object entry", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.json");
    await writeFile(
      truthPath,
      JSON.stringify([{ intent: "x", expected: "alpha" }, "not an object"]),
      "utf8",
    );

    await expect(
      runBench({ truthFile: truthPath, bank, embedder }),
    ).rejects.toThrow(/expected object/);
  });
});

describe("runBench — output structure", () => {
  it("queries[] preserves truth-file order", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      [
        { intent: "first", expected: "delta" },
        { intent: "second", expected: "alpha" },
        { intent: "third", expected: "charlie" },
      ]
        .map((t) => JSON.stringify(t))
        .join("\n"),
      "utf8",
    );

    const result = await runBench({ truthFile: truthPath, bank, embedder, rerankMode: "none" });
    expect(result.queries.map((q) => q.intent)).toEqual(["first", "second", "third"]);
    expect(result.queries.map((q) => q.expected)).toEqual(["delta", "alpha", "charlie"]);
  });

  it("respects --k for the cutoff but always reports top-1 and top-3", async () => {
    const { bank, embedder } = await setupBank();
    const truthPath = join(tmpDir, "truth.jsonl");
    await writeFile(
      truthPath,
      JSON.stringify({ intent: "x", expected: "alpha" }) + "\n",
      "utf8",
    );

    const result = await runBench({
      truthFile: truthPath,
      bank,
      embedder,
      rerankMode: "none",
      k: 5,
    });
    expect(result.k).toBe(5);
    expect(result.total).toBe(1);
    // top1 + top3 + topK are all defined regardless of k
    expect(typeof result.top1).toBe("number");
    expect(typeof result.top3).toBe("number");
    expect(typeof result.topK).toBe("number");
  });
});
