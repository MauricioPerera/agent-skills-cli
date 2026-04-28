// Tests for per-tenant audit scoping (v0.12.0+, SPEC §4.5.1).
//
// The feature: when a bank is shared by multiple agents/users (multi-tenant
// deployment), the intent-conditional rerank should ONLY count past audit
// entries from the current tenant — Alice's heavy use of skill A doesn't
// boost skill A on Bob's queries.
//
// Strategy:
//   1. Set up a bank with two skills (alpha, bravo).
//   2. Inject audit entries: tenant="alice" only used "alpha", tenant="bob"
//      only used "bravo".
//   3. runQuery({ tenant: "alice" }) on a neutral query — alpha should
//      get the rerank boost, bravo should not (Bob's history is invisible
//      to Alice).
//   4. runQuery({ tenant: "bob" }) symmetrically — only bravo gets boosted.
//   5. runQuery() with NO tenant — both contribute (the v0.11 behaviour;
//      single-tenant default).
//
// This exercises the full integration: AuditEntry schema, exec writes
// tenant, query filters audit by tenant, intent-conditional rerank uses
// only the filtered subset.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBank, type AuditEntry, type IndexedSkill } from "../src/lib/bank.js";
import { createStubEmbedder } from "../src/lib/embed.js";
import { runQuery } from "../src/commands/query.js";
import { runExec } from "../src/commands/exec.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-tenant-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Build a deterministic skill record. The stub embedder hashes its input
// into a vector; we override the bank's stored embedding directly to make
// cosine ranking predictable.
const buildSkill = (
  id: string,
  embedding: number[],
  embedderName: string,
): IndexedSkill => ({
  identity: `github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/${id}`,
  schema_version: "0.1",
  id,
  version: "1.0.0",
  title: `Skill ${id}`,
  description: `${id} description`,
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
  embedding_model: embedderName,
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
});

const oneHot = (i: number, dim = 32): number[] => {
  const v = new Array<number>(dim).fill(0.01);
  v[i] = 1;
  return v;
};

describe("tenant isolation — intent-conditional rerank", () => {
  it("Alice's history boosts only Alice's queries; Bob's history boosts only Bob's", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const dim = 32;
    const embedder = createStubEmbedder(dim);
    await bank.initMeta({ embedding_model: embedder.name, embedding_dim: dim });

    // Two skills with orthogonal vectors → cosine alone gives roughly equal
    // scores against a neutral query.
    const alpha = buildSkill("alpha", oneHot(0, dim), embedder.name);
    const bravo = buildSkill("bravo", oneHot(1, dim), embedder.name);
    await bank.upsertSkill(alpha);
    await bank.upsertSkill(bravo);

    // Embed the same neutral query both impls will use. We'll override
    // alpha's stored vector so it's *exactly* this query vector — high
    // cosine, equal to what bravo's would be after we override that one.
    const queryText = "neutral test intent";
    const queryVec = await embedder.embed(queryText);
    alpha.embedding = queryVec;
    bravo.embedding = queryVec;
    await bank.upsertSkill(alpha);
    await bank.upsertSkill(bravo);

    // Inject audit entries:
    //   - Alice used alpha 5 times with intents similar to the query
    //   - Bob used bravo 5 times with intents similar to the query
    // Both intents should pass the sim≥0.7 filter against the query.
    const aliceIntent = "alice variant of the test intent";
    const bobIntent = "bob variant of the test intent";
    for (let i = 0; i < 5; i++) {
      const entry: AuditEntry = {
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
        skill_id: alpha.identity,
        intent: aliceIntent,
        tenant: "alice",
        args: { x: "test" },
        exit_code: 0,
        elapsed_ms: 100,
      };
      await bank.appendAudit(entry);
    }
    for (let i = 0; i < 5; i++) {
      const entry: AuditEntry = {
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
        skill_id: bravo.identity,
        intent: bobIntent,
        tenant: "bob",
        args: { x: "test" },
        exit_code: 0,
        elapsed_ms: 100,
      };
      await bank.appendAudit(entry);
    }

    // Make alice's intent vector close to the query so it passes sim≥0.7.
    // The stub embedder is deterministic — we'll just check the integration
    // wiring: Alice's view should include alpha's boost; Bob's should not.
    //
    // Cosine on stub vectors isn't guaranteed to be ≥0.7 for arbitrary
    // strings, so we use a low threshold for this test. We're testing the
    // FILTER logic (audit entries matching tenant), not the rerank math
    // itself (which has its own tests).

    const queryAsAlice = await runQuery({
      intent: queryText,
      bank,
      embedder,
      rerankMode: "intent-conditional",
      rerankConfig: { similarityThreshold: -1 }, // accept all past intents
      tenant: "alice",
    });

    const queryAsBob = await runQuery({
      intent: queryText,
      bank,
      embedder,
      rerankMode: "intent-conditional",
      rerankConfig: { similarityThreshold: -1 },
      tenant: "bob",
    });

    // Alice's view: alpha has 5 conditional matches (her own audits),
    // bravo has 0 (Bob's audits filtered out).
    const aliceAlpha = queryAsAlice.hits.find((h) => h.identity === alpha.identity);
    const aliceBravo = queryAsAlice.hits.find((h) => h.identity === bravo.identity);
    expect(aliceAlpha?.conditional_count).toBe(5);
    expect(aliceBravo?.conditional_count).toBe(0);

    // Bob's view: symmetric.
    const bobAlpha = queryAsBob.hits.find((h) => h.identity === alpha.identity);
    const bobBravo = queryAsBob.hits.find((h) => h.identity === bravo.identity);
    expect(bobAlpha?.conditional_count).toBe(0);
    expect(bobBravo?.conditional_count).toBe(5);

    // Sanity: Alice's alpha score > Alice's bravo score (boost applied)
    // and conversely for Bob.
    expect(aliceAlpha!.score).toBeGreaterThan(aliceBravo!.score);
    expect(bobBravo!.score).toBeGreaterThan(bobAlpha!.score);
  });

  it("no tenant flag = single-user behaviour (every audit entry contributes)", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const dim = 32;
    const embedder = createStubEmbedder(dim);
    await bank.initMeta({ embedding_model: embedder.name, embedding_dim: dim });

    const alpha = buildSkill("alpha", oneHot(0, dim), embedder.name);
    const bravo = buildSkill("bravo", oneHot(1, dim), embedder.name);
    const queryVec = await embedder.embed("neutral query");
    alpha.embedding = queryVec;
    bravo.embedding = queryVec;
    await bank.upsertSkill(alpha);
    await bank.upsertSkill(bravo);

    // Mixed audit log: alice→alpha×3, bob→bravo×2, total 5 entries
    for (const [skill, tenant, n] of [
      [alpha, "alice", 3],
      [bravo, "bob", 2],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await bank.appendAudit({
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          skill_id: skill.identity,
          intent: "shared intent",
          tenant,
          args: { x: "test" },
          exit_code: 0,
          elapsed_ms: 100,
        });
      }
    }

    // Without --tenant, BOTH alice's and bob's entries should contribute.
    const result = await runQuery({
      intent: "neutral query",
      bank,
      embedder,
      rerankMode: "intent-conditional",
      rerankConfig: { similarityThreshold: -1 },
      // no tenant
    });

    const a = result.hits.find((h) => h.identity === alpha.identity);
    const b = result.hits.find((h) => h.identity === bravo.identity);
    expect(a?.conditional_count).toBe(3);
    expect(b?.conditional_count).toBe(2);
  });
});

describe("tenant isolation — exec writes tenant to audit log", () => {
  it("runExec({ tenant: 'x' }) records tenant on the audit entry", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const dim = 32;
    const embedder = createStubEmbedder(dim);
    await bank.initMeta({ embedding_model: embedder.name, embedding_dim: dim });

    // Minimal skill that runs `echo {x}` — known good from other tests.
    const skill = buildSkill("echo-test", oneHot(0, dim), embedder.name);
    await bank.upsertSkill(skill);

    const result = await runExec({
      bank,
      skillIdentifier: skill.identity,
      args: { x: "hello" },
      tenant: "alice",
    });

    expect(result.exit_code).toBe(0);

    const entries = await bank.listAudit({});
    expect(entries.length).toBe(1);
    expect(entries[0]?.tenant).toBe("alice");
    expect(entries[0]?.skill_id).toBe(skill.identity);
  });

  it("runExec without tenant does NOT add a tenant field (omitted, not null)", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const dim = 32;
    const embedder = createStubEmbedder(dim);
    await bank.initMeta({ embedding_model: embedder.name, embedding_dim: dim });

    const skill = buildSkill("echo-test", oneHot(0, dim), embedder.name);
    await bank.upsertSkill(skill);

    await runExec({
      bank,
      skillIdentifier: skill.identity,
      args: { x: "hello" },
    });

    const entries = await bank.listAudit({});
    expect(entries[0]?.tenant).toBeUndefined();
    // The serialised JSONL line should NOT contain the "tenant" key — backwards
    // compat: existing audit-log readers ignoring undefined fields work.
    expect(JSON.stringify(entries[0])).not.toContain("tenant");
  });
});
