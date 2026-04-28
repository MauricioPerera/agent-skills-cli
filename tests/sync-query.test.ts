// Integration tests for sync + query end-to-end, with mocked fetch and stub
// embedder. Verifies that the orchestration works without hitting any real
// network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBank } from "../src/lib/bank.js";
import { createStubEmbedder } from "../src/lib/embed.js";
import { runSync } from "../src/commands/sync.js";
import { runQuery } from "../src/commands/query.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-sync-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const VALID_SKILL_MD = (id: string, useWhen: string): string => `---
schema_version: "0.1"
id: "${id}"
version: "1.0.0"
title: "${id}"
description: "Skill ${id} for tests"
use_when: "${useWhen}"
command_template: "echo {msg}"
args:
  msg:
    type: string
license: "MIT"
---

# ${id}
`;

const FAKE_SHA = "a1b2c3d4e5f67890abcdef1234567890abcdef12";

describe("runSync — happy path with mocked fetch + stub embedder", () => {
  it("syncs three skills end-to-end and persists subscription", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    const fakeFetch: typeof fetch = async (url) => {
      const u = url.toString();
      // GitHub API: ref → sha resolution
      if (u.includes("api.github.com/repos") && u.includes("/git/refs/tags/v1.0.0")) {
        return new Response(
          JSON.stringify({ object: { sha: FAKE_SHA } }),
          { status: 200 },
        );
      }
      // skills-index.json
      if (u.endsWith("/skills-index.json")) {
        return new Response(
          JSON.stringify({
            schema_version: "0.1",
            skills: [
              { id: "alpha", version: "1.0.0", url: `https://cdn.example.com/alpha/SKILL.md` },
              { id: "beta",  version: "1.0.0", url: `https://cdn.example.com/beta/SKILL.md` },
              { id: "gamma", version: "1.0.0", url: `https://cdn.example.com/gamma/SKILL.md` },
            ],
          }),
          { status: 200 },
        );
      }
      // Each SKILL.md
      if (u.endsWith("/alpha/SKILL.md")) {
        return new Response(VALID_SKILL_MD("alpha", "fetch a URL"), { status: 200 });
      }
      if (u.endsWith("/beta/SKILL.md")) {
        return new Response(VALID_SKILL_MD("beta", "create a GitHub issue"), { status: 200 });
      }
      if (u.endsWith("/gamma/SKILL.md")) {
        return new Response(VALID_SKILL_MD("gamma", "encode a string"), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await runSync({
      source: "github.com/test/pack@v1.0.0",
      bank,
      embedder,
      fetchFn: fakeFetch,
    });

    expect(result.total).toBe(3);
    expect(result.synced).toBe(3);
    expect(result.invalid).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.ref_resolved).toBe(FAKE_SHA);

    // Bank metadata is initialized
    const meta = await bank.getMeta();
    expect(meta?.embedding_model).toBe(embedder.name);

    // 3 skills indexed
    const allSkills = await bank.listSkills();
    expect(allSkills).toHaveLength(3);

    // Subscription persisted
    const subs = await bank.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.ref_resolved).toBe(FAKE_SHA);
  });

  it("skill provenance is computed at ingest with the resolved hash", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    const fakeFetch: typeof fetch = async (url) => {
      const u = url.toString();
      if (u.includes("/git/refs/tags/")) {
        return new Response(JSON.stringify({ object: { sha: FAKE_SHA } }), { status: 200 });
      }
      if (u.endsWith("/skills-index.json")) {
        return new Response(JSON.stringify({
          schema_version: "0.1",
          skills: [{ id: "x", version: "1.0.0", url: "https://cdn.example.com/x/SKILL.md" }],
        }), { status: 200 });
      }
      return new Response(VALID_SKILL_MD("x", "do x"), { status: 200 });
    };

    await runSync({
      source: "github.com/test/pack@v1.0.0",
      bank,
      embedder,
      fetchFn: fakeFetch,
    });

    const skill = await bank.getSkill(`github.com/test/pack@${FAKE_SHA}/x`);
    expect(skill?.provenance.ref_resolved_to).toBe(FAKE_SHA);
    expect(skill?.provenance.source).toBe("github.com/test/pack");
    expect(skill?.provenance.signature_status).toBe("unsigned");
    expect(skill?.embedding_model).toBe(embedder.name);
    expect(skill?.embedding).toHaveLength(32);
  });
});

describe("runSync — invalid skills don't abort the batch", () => {
  it("invalid skill is reported but valid ones are still ingested", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    const INVALID_SKILL = `---
schema_version: "0.1"
id: "broken"
# missing required: version, title, description, use_when, command_template
---`;

    const fakeFetch: typeof fetch = async (url) => {
      const u = url.toString();
      if (u.includes("/git/refs/tags/")) {
        return new Response(JSON.stringify({ object: { sha: FAKE_SHA } }), { status: 200 });
      }
      if (u.endsWith("/skills-index.json")) {
        return new Response(JSON.stringify({
          schema_version: "0.1",
          skills: [
            { id: "good",   version: "1.0.0", url: "https://cdn.example.com/good/SKILL.md" },
            { id: "broken", version: "1.0.0", url: "https://cdn.example.com/broken/SKILL.md" },
          ],
        }), { status: 200 });
      }
      if (u.includes("/good/SKILL.md")) {
        return new Response(VALID_SKILL_MD("good", "good things"), { status: 200 });
      }
      if (u.includes("/broken/SKILL.md")) {
        return new Response(INVALID_SKILL, { status: 200 });
      }
      return new Response("404", { status: 404 });
    };

    const result = await runSync({
      source: "github.com/test/pack@v1.0.0",
      bank,
      embedder,
      fetchFn: fakeFetch,
    });

    expect(result.synced).toBe(1);
    expect(result.invalid).toBe(1);
    const good = result.skills.find((s) => s.id === "good");
    const broken = result.skills.find((s) => s.id === "broken");
    expect(good?.status).toBe("synced");
    expect(broken?.status).toBe("invalid");
    expect(broken?.errors?.length).toBeGreaterThan(0);
  });
});

describe("runQuery — happy path", () => {
  it("returns top-K results from the populated bank", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    // Populate via sync
    const fakeFetch: typeof fetch = async (url) => {
      const u = url.toString();
      if (u.includes("/git/refs/tags/")) {
        return new Response(JSON.stringify({ object: { sha: FAKE_SHA } }), { status: 200 });
      }
      if (u.endsWith("/skills-index.json")) {
        return new Response(JSON.stringify({
          schema_version: "0.1",
          skills: [
            { id: "http-get",  version: "1.0.0", url: "https://cdn.example.com/http-get/SKILL.md" },
            { id: "json-query", version: "1.0.0", url: "https://cdn.example.com/json-query/SKILL.md" },
            { id: "base64-encode", version: "1.0.0", url: "https://cdn.example.com/base64-encode/SKILL.md" },
          ],
        }), { status: 200 });
      }
      if (u.includes("/http-get/")) {
        return new Response(VALID_SKILL_MD("http-get", "fetch the contents of a URL"), { status: 200 });
      }
      if (u.includes("/json-query/")) {
        return new Response(VALID_SKILL_MD("json-query", "filter or transform JSON"), { status: 200 });
      }
      if (u.includes("/base64-encode/")) {
        return new Response(VALID_SKILL_MD("base64-encode", "encode a string as base64"), { status: 200 });
      }
      return new Response("404", { status: 404 });
    };

    await runSync({ source: "github.com/test/pack@v1.0.0", bank, embedder, fetchFn: fakeFetch });

    // Query for an http-related intent
    const result = await runQuery({
      intent: "fetch the contents of a URL",
      k: 2,
      bank,
      embedder,
    });

    expect(result.hits.length).toBe(2);
    // Stub embedder is hash-based, not semantic, so we don't assert ranking.
    // What we DO assert: the query went through embedding + cosine search,
    // returned valid skill records with the expected fields.
    for (const hit of result.hits) {
      expect(typeof hit.score).toBe("number");
      expect(hit.score).toBeGreaterThanOrEqual(-1);
      expect(hit.score).toBeLessThanOrEqual(1);
      expect(hit.command_template).toBeTruthy();
      expect(hit.title).toBeTruthy();
      expect(hit.identity).toMatch(/^github\.com\/test\/pack@[a-f0-9]+\//);
    }
  });

  it("rejects when bank not initialized", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);
    await expect(
      runQuery({ intent: "test", bank, embedder }),
    ).rejects.toThrow(/not initialized/);
  });

  it("rejects on embedder mismatch", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.initMeta({ embedding_model: "stub:fnv1a-32", embedding_dim: 32 });
    const otherEmbedder = createStubEmbedder(64); // different dim
    await expect(
      runQuery({ intent: "test", bank, embedder: otherEmbedder }),
    ).rejects.toThrow(/mismatch/);
  });

  it("rejects empty intent", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);
    await bank.initMeta({ embedding_model: embedder.name, embedding_dim: 32 });
    await expect(
      runQuery({ intent: "  ", bank, embedder }),
    ).rejects.toThrow(/empty/);
  });
});

// v0.6.1: bounded concurrency in runSync.
describe("runSync — bounded concurrency (v0.6.1+)", () => {
  it("syncs all skills with concurrency=4 and preserves index order in results", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    // 12 skills — enough to overflow the 4-wide pool multiple times.
    const ids = Array.from({ length: 12 }, (_, i) => `skill-${String(i).padStart(2, "0")}`);

    let inflight = 0;
    let peakInflight = 0;

    const fakeFetch: typeof fetch = async (url) => {
      const u = url.toString();
      if (u.includes("/git/refs/tags/")) {
        return new Response(JSON.stringify({ object: { sha: FAKE_SHA } }), { status: 200 });
      }
      if (u.endsWith("/skills-index.json")) {
        return new Response(JSON.stringify({
          schema_version: "0.1",
          skills: ids.map((id) => ({
            id, version: "1.0.0", url: `https://cdn.example.com/${id}/SKILL.md`,
          })),
        }), { status: 200 });
      }
      const m = u.match(/\/(skill-\d+)\/SKILL\.md$/);
      if (m) {
        // Track concurrent in-flight skill fetches (these are gated by the
        // worker pool, so peak ≤ concurrency).
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        return new Response(VALID_SKILL_MD(m[1] as string, `do ${m[1]}`), { status: 200 });
      }
      return new Response("404", { status: 404 });
    };

    const result = await runSync({
      source: "github.com/test/big-pack@v1.0.0",
      bank,
      embedder,
      fetchFn: fakeFetch,
      concurrency: 4,
    });

    expect(result.total).toBe(12);
    expect(result.synced).toBe(12);

    // Order MUST match the index, not completion order
    expect(result.skills.map((s) => s.id)).toEqual(ids);

    // Peak in-flight must respect the limit
    expect(peakInflight).toBeGreaterThan(1);
    expect(peakInflight).toBeLessThanOrEqual(4);
  });

  it("concurrency=1 forces sequential (peak in-flight = 1)", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    let inflight = 0;
    let peak = 0;
    const fakeFetch: typeof fetch = async (url) => {
      const u = url.toString();
      if (u.includes("/git/refs/tags/")) {
        return new Response(JSON.stringify({ object: { sha: FAKE_SHA } }), { status: 200 });
      }
      if (u.endsWith("/skills-index.json")) {
        return new Response(JSON.stringify({
          schema_version: "0.1",
          skills: [
            { id: "a", version: "1.0.0", url: "https://cdn.example.com/a/SKILL.md" },
            { id: "b", version: "1.0.0", url: "https://cdn.example.com/b/SKILL.md" },
            { id: "c", version: "1.0.0", url: "https://cdn.example.com/c/SKILL.md" },
          ],
        }), { status: 200 });
      }
      const m = u.match(/\/([abc])\/SKILL\.md$/);
      if (m) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        return new Response(VALID_SKILL_MD(m[1] as string, `do ${m[1]}`), { status: 200 });
      }
      return new Response("404", { status: 404 });
    };

    await runSync({
      source: "github.com/test/pack@v1.0.0",
      bank,
      embedder,
      fetchFn: fakeFetch,
      concurrency: 1,
    });
    expect(peak).toBe(1);
  });
});
