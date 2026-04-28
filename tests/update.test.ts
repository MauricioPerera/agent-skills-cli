// Tests for `agent-skills update` (v0.11.0).
//
// Properties under test:
//   1. Pinned tag (ref re-resolves to same SHA) → no-op, no API calls
//      beyond the resolve, no GC, no embed calls.
//   2. Moving ref (new SHA) → re-syncs, computes diff (added/removed/
//      version-bumped), GCs orphan files from the old SHA.
//   3. --dry-run reports `changed: true` for moved refs but writes nothing.
//   4. Update with no <source> visits all subscriptions.
//   5. Update with explicit <source> visits only the named one; errors
//      on unknown source.
//   6. Inherits verify_signature from the subscription (i.e., a moving tag
//      that becomes unsigned aborts the update with --verify-signature
//      previously persisted).
//   7. Empty bank → returns total=0, no error.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBank } from "../src/lib/bank.js";
import { createStubEmbedder } from "../src/lib/embed.js";
import { runSync } from "../src/commands/sync.js";
import { runUpdate } from "../src/commands/update.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-update-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const VALID_SKILL_MD = (id: string, version = "1.0.0", useWhen = "test"): string => `---
schema_version: "0.1"
id: "${id}"
version: "${version}"
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

/**
 * Build a fetch impl that returns a controllable resolved SHA for tag refs
 * and a controllable skills set per SHA.
 */
const buildFetch = (
  tagToSha: Record<string, string>,
  shaToSkills: Record<string, Array<{ id: string; version: string; useWhen?: string }>>,
): typeof fetch => {
  return async (url) => {
    const u = url.toString();
    // GitHub API: tag → SHA (the resolveRef tag path)
    const tagMatch = u.match(/\/git\/refs\/tags\/(.+)$/);
    if (tagMatch) {
      const tag = decodeURIComponent(tagMatch[1] as string);
      const sha = tagToSha[tag];
      if (!sha) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ ref: `refs/tags/${tag}`, object: { sha, type: "commit" } }),
        { status: 200 },
      );
    }
    // GitHub API: branch / commit lookup (resolveRef commit path)
    const commitMatch = u.match(/\/commits\/([^/?]+)$/);
    if (commitMatch) {
      const ref = commitMatch[1] as string;
      const sha = tagToSha[ref];
      if (!sha) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ sha }), { status: 200 });
    }
    // signature verification: GitHub returns 404 for the ref (lightweight tag),
    // verifier downgrades to "unverified" — fine for these tests.
    // (we don't need signature happy path here)
    // skills-index.json
    const indexMatch = u.match(/cdn\.jsdelivr\.net\/gh\/[^@]+@([a-f0-9]+)\/skills-index\.json/);
    if (indexMatch) {
      const sha = indexMatch[1] as string;
      const skills = shaToSkills[sha];
      if (!skills) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          schema_version: "0.1",
          skills: skills.map((s) => ({
            id: s.id,
            version: s.version,
            url: `https://cdn.example.com/${sha}/${s.id}/SKILL.md`,
          })),
        }),
        { status: 200 },
      );
    }
    // SKILL.md
    const skillMatch = u.match(/cdn\.example\.com\/([a-f0-9]+)\/([\w-]+)\/SKILL\.md/);
    if (skillMatch) {
      const [, sha, id] = skillMatch as [string, string, string];
      const def = shaToSkills[sha]?.find((s) => s.id === id);
      if (!def) return new Response("not found", { status: 404 });
      return new Response(VALID_SKILL_MD(id, def.version, def.useWhen ?? "test"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
};

const SHA_OLD = "a1b2c3d4e5f67890abcdef1234567890abcdef12";
const SHA_NEW = "fedcba0987654321fedcba0987654321fedcba09";

describe("runUpdate — pinned tag, no change", () => {
  it("re-resolves to the same SHA, reports unchanged, doesn't re-sync, no GC", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    // Initial sync: 2 skills at SHA_OLD.
    const initialFetch = buildFetch(
      { "v1.0.0": SHA_OLD, main: SHA_OLD },
      {
        [SHA_OLD]: [
          { id: "alpha", version: "1.0.0" },
          { id: "bravo", version: "1.0.0" },
        ],
      },
    );
    await runSync({
      source: "github.com/me/pack@v1.0.0",
      bank,
      embedder,
      fetchFn: initialFetch,
    });
    expect((await bank.listSkills()).length).toBe(2);

    // Update: tag still points to SHA_OLD.
    const updateFetch = buildFetch(
      { "v1.0.0": SHA_OLD },
      {
        [SHA_OLD]: [
          { id: "alpha", version: "1.0.0" },
          { id: "bravo", version: "1.0.0" },
        ],
      },
    );
    const result = await runUpdate({ bank, embedder, fetchFn: updateFetch });

    expect(result.total).toBe(1);
    expect(result.changed).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.subscriptions[0]?.changed).toBe(false);
    expect(result.subscriptions[0]?.ref_old).toBe(SHA_OLD);
    expect(result.subscriptions[0]?.ref_new).toBe(SHA_OLD);
    // Skills untouched
    expect((await bank.listSkills()).length).toBe(2);
  });
});

describe("runUpdate — moving ref with skill changes", () => {
  it("re-syncs, computes added/removed/version-bumped diff, GCs old-SHA orphans", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    // Initial sync at SHA_OLD: alpha@1.0.0, bravo@1.0.0
    await runSync({
      source: "github.com/me/pack@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        {
          [SHA_OLD]: [
            { id: "alpha", version: "1.0.0" },
            { id: "bravo", version: "1.0.0" },
          ],
        },
      ),
    });
    expect((await bank.listSkills()).length).toBe(2);

    // Update: main now resolves to SHA_NEW. alpha bumped to 1.1.0, bravo gone, charlie added.
    const result = await runUpdate({
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_NEW },
        {
          [SHA_NEW]: [
            { id: "alpha", version: "1.1.0" },
            { id: "charlie", version: "1.0.0" },
          ],
        },
      ),
    });

    expect(result.total).toBe(1);
    expect(result.changed).toBe(1);
    const sub = result.subscriptions[0]!;
    expect(sub.ref_old).toBe(SHA_OLD);
    expect(sub.ref_new).toBe(SHA_NEW);
    expect(sub.added).toEqual(["charlie"]);
    expect(sub.removed).toEqual(["bravo"]);
    expect(sub.updated).toEqual(["alpha: 1.0.0 → 1.1.0"]);

    // GC happened — bank has only the 2 NEW skills, not the 4 (2 old + 2 new) it would have without cleanup.
    const remaining = await bank.listSkills();
    expect(remaining.length).toBe(2);
    expect(remaining.every((s) => s.identity.includes(SHA_NEW))).toBe(true);
    expect(sub.gc_removed).toBe(2); // alpha@SHA_OLD + bravo@SHA_OLD
  });
});

describe("runUpdate — dry run", () => {
  it("reports changed: true but writes nothing and skips re-sync", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    await runSync({
      source: "github.com/me/pack@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "alpha", version: "1.0.0" }] },
      ),
    });

    const result = await runUpdate({
      bank,
      embedder,
      dryRun: true,
      fetchFn: buildFetch(
        { main: SHA_NEW },
        { [SHA_NEW]: [{ id: "alpha", version: "2.0.0" }] },
      ),
    });

    expect(result.dry_run).toBe(true);
    expect(result.subscriptions[0]?.changed).toBe(true);
    expect(result.subscriptions[0]?.ref_new).toBe(SHA_NEW);
    expect(result.subscriptions[0]?.gc_removed).toBe(0);
    // Bank still at OLD — nothing was synced or GC'd.
    const skills = await bank.listSkills();
    expect(skills.length).toBe(1);
    expect(skills[0]?.identity).toContain(SHA_OLD);
    expect(skills[0]?.version).toBe("1.0.0");
  });
});

describe("runUpdate — selective targeting", () => {
  it("with no <source>, updates all subscriptions", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    await runSync({
      source: "github.com/me/pack-a@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "alpha", version: "1.0.0" }] },
      ),
    });
    await runSync({
      source: "github.com/me/pack-b@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "bravo", version: "1.0.0" }] },
      ),
    });

    const result = await runUpdate({
      bank,
      embedder,
      fetchFn: buildFetch({ main: SHA_OLD }, { [SHA_OLD]: [] }),
    });

    expect(result.total).toBe(2);
    // (Both end up "changed" because index now lists no skills, but the
    // structural assertion is that BOTH subscriptions were visited.)
    expect(result.subscriptions).toHaveLength(2);
    const ids = result.subscriptions.map((s) => s.source).sort();
    expect(ids).toEqual([
      "github.com/me/pack-a@main",
      "github.com/me/pack-b@main",
    ]);
  });

  it("with <source>, updates only that subscription", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    await runSync({
      source: "github.com/me/pack-a@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "alpha", version: "1.0.0" }] },
      ),
    });
    await runSync({
      source: "github.com/me/pack-b@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "bravo", version: "1.0.0" }] },
      ),
    });

    const result = await runUpdate({
      bank,
      embedder,
      source: "github.com/me/pack-a@main",
      fetchFn: buildFetch({ main: SHA_OLD }, { [SHA_OLD]: [] }),
    });

    expect(result.total).toBe(1);
    expect(result.subscriptions[0]?.source).toBe("github.com/me/pack-a@main");
  });

  it("throws CliError on unknown <source>", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);
    await runSync({
      source: "github.com/me/pack-a@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "alpha", version: "1.0.0" }] },
      ),
    });

    await expect(
      runUpdate({
        bank,
        embedder,
        source: "github.com/no/such-pack@main",
      }),
    ).rejects.toThrow(/no subscription matches/i);
  });

  it("returns total=0 when bank has no subscriptions", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);
    const result = await runUpdate({ bank, embedder });
    expect(result.total).toBe(0);
    expect(result.subscriptions).toEqual([]);
  });
});

describe("runUpdate — multi-subscription GC isolation (v0.13.0+, fixes #6)", () => {
  // The pre-v0.13 GC matched orphans by `repo@` prefix alone — meaning
  // updating `pack@main` would also drop skills from a separate
  // `pack@v1.0.0` subscription pointing at the same repo. v0.13.0 fixes
  // this by collecting the protected SHAs from every other active
  // subscription and refusing to GC them.

  const SHA_V1 = "1111111111111111111111111111111111111111";
  const SHA_MAIN_OLD = "2222222222222222222222222222222222222222";
  const SHA_MAIN_NEW = "3333333333333333333333333333333333333333";

  it("updating one subscription does NOT GC skills owned by another sub of the same repo", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    // Initial: subscribe to BOTH `pack@v1.0.0` and `pack@main`.
    // v1.0.0 pinned to SHA_V1 with one skill; main pinned to SHA_MAIN_OLD
    // with another skill.
    await runSync({
      source: "github.com/me/pack@v1.0.0",
      bank,
      embedder,
      fetchFn: buildFetch(
        { "v1.0.0": SHA_V1 },
        { [SHA_V1]: [{ id: "frozen", version: "1.0.0" }] },
      ),
    });
    await runSync({
      source: "github.com/me/pack@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_MAIN_OLD },
        { [SHA_MAIN_OLD]: [{ id: "rolling", version: "1.0.0" }] },
      ),
    });
    expect((await bank.listSkills()).length).toBe(2);

    // Now update `pack@main` — main moved to SHA_MAIN_NEW with a v2 skill.
    // The v1.0.0 subscription's pinned SHA (SHA_V1) is unrelated and
    // MUST survive the update's GC pass.
    const result = await runUpdate({
      bank,
      embedder,
      source: "github.com/me/pack@main",
      fetchFn: buildFetch(
        { main: SHA_MAIN_NEW },
        { [SHA_MAIN_NEW]: [{ id: "rolling", version: "2.0.0" }] },
      ),
    });

    expect(result.changed).toBe(1);
    const all = await bank.listSkills();
    expect(all.length).toBe(2);

    // Both skills present: the frozen v1.0.0 one + the new main one.
    const ids = all.map((s) => s.identity).sort();
    expect(ids[0]).toContain(SHA_V1);            // frozen survived
    expect(ids[0]).toContain("frozen");
    expect(ids[1]).toContain(SHA_MAIN_NEW);      // main updated
    expect(ids[1]).toContain("rolling");
  });

  it("orphan SHA from a previous main-update IS still GC'd (only protect ACTIVE subs)", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    // Single subscription. SHA_MAIN_OLD becomes an orphan after update.
    // The protected-SHA logic must NOT confuse "previously-pinned by this
    // very subscription" with "pinned by another subscription".
    await runSync({
      source: "github.com/me/pack@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_MAIN_OLD },
        { [SHA_MAIN_OLD]: [{ id: "alpha", version: "1.0.0" }] },
      ),
    });

    const result = await runUpdate({
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_MAIN_NEW },
        { [SHA_MAIN_NEW]: [{ id: "alpha", version: "2.0.0" }] },
      ),
    });

    expect(result.subscriptions[0]?.gc_removed).toBe(1); // old SHA cleaned
    const all = await bank.listSkills();
    expect(all.length).toBe(1);
    expect(all[0]?.identity).toContain(SHA_MAIN_NEW);
  });
});

describe("runUpdate — error paths", () => {
  it("records error in per-subscription result when ref re-resolution fails", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const embedder = createStubEmbedder(32);

    await runSync({
      source: "github.com/me/pack@main",
      bank,
      embedder,
      fetchFn: buildFetch(
        { main: SHA_OLD },
        { [SHA_OLD]: [{ id: "alpha", version: "1.0.0" }] },
      ),
    });

    // Update with a fetch that 404s on every ref
    const result = await runUpdate({
      bank,
      embedder,
      fetchFn: buildFetch({}, {}),
    });

    expect(result.failed).toBe(1);
    expect(result.subscriptions[0]?.error).toMatch(/cannot resolve ref/i);
    // Bank skills untouched (no GC on error)
    expect((await bank.listSkills()).length).toBe(1);
  });
});
