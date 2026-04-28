import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBank, type IndexedSkill } from "../../src/lib/bank.js";
import { createStubEmbedder } from "../../src/lib/embed.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-bank-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const buildSkill = (overrides: Partial<IndexedSkill> = {}): IndexedSkill => ({
  identity: "github.com/x/y@a1b2c3d4e5f67890abcdef1234567890abcdef12/test",
  schema_version: "0.1",
  id: "test",
  version: "1.0.0",
  title: "Test skill",
  description: "A skill for testing",
  use_when: "writing unit tests",
  command_template: "echo {x}",
  args: { x: { type: "string" } },
  provenance: {
    source_type: "git",
    source: "github.com/x/y",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "unsigned",
  },
  embedding: new Array(32).fill(0).map((_, i) => i / 32),
  embedding_model: "stub:fnv1a-32",
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
  ...overrides,
});

describe("FileBank — initMeta + getMeta", () => {
  it("initializes meta with embedding info", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.initMeta({ embedding_model: "stub:32", embedding_dim: 32 });
    const meta = await bank.getMeta();
    expect(meta?.embedding_model).toBe("stub:32");
    expect(meta?.embedding_dim).toBe(32);
    expect(meta?.schema_version).toBe("0.1");
    expect(meta?.created_at).toBeTruthy();
  });

  it("getMeta returns null when uninitialized", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    expect(await bank.getMeta()).toBeNull();
  });

  it("initMeta is idempotent for same model", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.initMeta({ embedding_model: "stub:32", embedding_dim: 32 });
    await bank.initMeta({ embedding_model: "stub:32", embedding_dim: 32 });
    const meta = await bank.getMeta();
    expect(meta?.embedding_model).toBe("stub:32");
  });

  it("initMeta refuses model mismatch", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.initMeta({ embedding_model: "stub:32", embedding_dim: 32 });
    await expect(
      bank.initMeta({ embedding_model: "different-model", embedding_dim: 64 }),
    ).rejects.toThrow(/refusing to mix/);
  });
});

describe("FileBank — subscriptions", () => {
  it("upsert inserts new subscription", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSubscription({
      id: "github.com/x/y",
      source_type: "git",
      repo: "github.com/x/y",
      ref_requested: "v1.0.0",
      auto_update: false,
    });
    const subs = await bank.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.id).toBe("github.com/x/y");
  });

  it("upsert updates existing subscription (matched by id)", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSubscription({
      id: "x",
      source_type: "git",
      repo: "github.com/x/y",
      ref_requested: "v1.0.0",
      auto_update: false,
    });
    await bank.upsertSubscription({
      id: "x",
      source_type: "git",
      repo: "github.com/x/y",
      ref_requested: "v2.0.0",
      ref_resolved: "abc123",
      auto_update: false,
    });
    const subs = await bank.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.ref_requested).toBe("v2.0.0");
    expect(subs[0]?.ref_resolved).toBe("abc123");
  });

  it("listSubscriptions returns [] when no subs", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    expect(await bank.listSubscriptions()).toEqual([]);
  });
});

describe("FileBank — skills", () => {
  it("upsert + get a skill round-trips", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const skill = buildSkill();
    await bank.upsertSkill(skill);
    const fetched = await bank.getSkill(skill.identity);
    expect(fetched?.identity).toBe(skill.identity);
    expect(fetched?.title).toBe("Test skill");
  });

  it("listSkills returns all stored skills", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill({ identity: "id-1", id: "one" }));
    await bank.upsertSkill(buildSkill({ identity: "id-2", id: "two" }));
    const all = await bank.listSkills();
    expect(all).toHaveLength(2);
  });

  it("upsert overwrites an existing skill", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill({ title: "v1" }));
    await bank.upsertSkill(buildSkill({ title: "v2" }));
    const all = await bank.listSkills();
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toBe("v2");
  });

  it("removeSkill returns true on success, false on missing", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const skill = buildSkill();
    await bank.upsertSkill(skill);
    expect(await bank.removeSkill(skill.identity)).toBe(true);
    expect(await bank.removeSkill(skill.identity)).toBe(false);
    expect(await bank.removeSkill("never-existed")).toBe(false);
  });
});

describe("FileBank — vector search", () => {
  it("returns top-K skills sorted by cosine similarity", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const e = createStubEmbedder(32);

    // Index three skills with deterministic embeddings
    const a = await e.embed("HTTP GET request");
    const b = await e.embed("create a GitHub issue");
    const c = await e.embed("base64 encode a string");
    await bank.upsertSkill(buildSkill({ identity: "a", title: "HTTP GET", embedding: a }));
    await bank.upsertSkill(buildSkill({ identity: "b", title: "GH issue", embedding: b }));
    await bank.upsertSkill(buildSkill({ identity: "c", title: "Base64", embedding: c }));

    // Query with a similar embedding to skill A
    const q = await e.embed("HTTP GET request");
    const hits = await bank.search(q, 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.skill.identity).toBe("a"); // exact match → top
    expect(hits[0]?.score).toBeCloseTo(1.0, 5);
  });

  it("returns at most k results", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const e = createStubEmbedder(32);
    for (let i = 0; i < 5; i++) {
      const v = await e.embed(`skill ${i}`);
      await bank.upsertSkill(buildSkill({ identity: `id-${i}`, embedding: v }));
    }
    const q = await e.embed("test query");
    const hits = await bank.search(q, 2);
    expect(hits).toHaveLength(2);
  });

  it("returns empty array on empty bank", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const e = createStubEmbedder(32);
    const q = await e.embed("anything");
    expect(await bank.search(q, 5)).toEqual([]);
  });
});

describe("FileBank — reset", () => {
  it("wipes all state", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.initMeta({ embedding_model: "stub:32", embedding_dim: 32 });
    await bank.upsertSkill(buildSkill());
    await bank.upsertSubscription({
      id: "x",
      source_type: "git",
      auto_update: false,
    });

    await bank.reset();

    expect(await bank.getMeta()).toBeNull();
    expect(await bank.listSkills()).toEqual([]);
    expect(await bank.listSubscriptions()).toEqual([]);
  });
});
