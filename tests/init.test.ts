// Tests for `agent-skills init` (v0.9.0).
//
// Two strict properties under test (not just shape, behaviour):
//
//   1. The generated SKILL.md MUST validate against the v0.1 spec out of
//      the box. The whole point is "scaffold → publish --check-only is green".
//
//   2. After scaffolding a full pack with --pack, running runPublish on it
//      MUST succeed with no validation failures, AND a re-publish MUST be
//      a byte-identical no-op (proves init produces a publish-ready pack).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.js";
import { runPublish } from "../src/commands/publish.js";
import { parseSkillSource } from "../src/lib/parse-skill.js";
import { validateSkill } from "../src/lib/validate.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-init-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("runInit — single skill mode", () => {
  it("scaffolds skills/<name>/SKILL.md and the result validates against the spec", async () => {
    const result = await runInit({ name: "my-skill", dir: tmpDir });

    expect(result.mode).toBe("skill");
    expect(result.files_written).toEqual([join("skills", "my-skill", "SKILL.md")]);
    expect(result.files_skipped).toEqual([]);

    const generated = await readFile(
      join(tmpDir, "skills", "my-skill", "SKILL.md"),
      "utf8",
    );
    const parsed = parseSkillSource(generated);
    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.body).not.toBeNull();
    expect(parsed.frontmatter?.id).toBe("my-skill");

    // The KEY property: the scaffolded file MUST pass full validation.
    const v = validateSkill(parsed.frontmatter);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("--in <dir> writes to a non-cwd location", async () => {
    const result = await runInit({ name: "alpha", dir: join(tmpDir, "subdir") });

    expect(result.files_written).toEqual([join("skills", "alpha", "SKILL.md")]);
    const s = await stat(join(tmpDir, "subdir", "skills", "alpha", "SKILL.md"));
    expect(s.isFile()).toBe(true);
  });

  it("refuses to overwrite an existing SKILL.md without --force", async () => {
    await runInit({ name: "alpha", dir: tmpDir });
    const first = await readFile(join(tmpDir, "skills", "alpha", "SKILL.md"), "utf8");

    const second = await runInit({ name: "alpha", dir: tmpDir });
    expect(second.files_written).toEqual([]);
    expect(second.files_skipped).toEqual([join("skills", "alpha", "SKILL.md")]);

    const after = await readFile(join(tmpDir, "skills", "alpha", "SKILL.md"), "utf8");
    expect(after).toBe(first);
  });

  it("--force overwrites existing files", async () => {
    await runInit({ name: "alpha", dir: tmpDir, authorName: "Alice" });
    const second = await runInit({
      name: "alpha",
      dir: tmpDir,
      authorName: "Bob",
      force: true,
    });

    expect(second.files_written).toEqual([join("skills", "alpha", "SKILL.md")]);
    expect(second.files_skipped).toEqual([]);

    const generated = await readFile(
      join(tmpDir, "skills", "alpha", "SKILL.md"),
      "utf8",
    );
    expect(generated).toContain("Bob");
    expect(generated).not.toContain("Alice");
  });

  it("rejects names with shell metacharacters", async () => {
    await expect(runInit({ name: "../etc/passwd", dir: tmpDir })).rejects.toThrow(
      /must match/,
    );
    await expect(runInit({ name: "name with spaces", dir: tmpDir })).rejects.toThrow(
      /must match/,
    );
    await expect(runInit({ name: "$evil", dir: tmpDir })).rejects.toThrow(/must match/);
  });

  it("includes author block when --author is provided", async () => {
    await runInit({ name: "alpha", dir: tmpDir, authorName: "Carol Smith" });
    const generated = await readFile(
      join(tmpDir, "skills", "alpha", "SKILL.md"),
      "utf8",
    );
    expect(generated).toContain("Carol Smith");
    // The author block should NOT be commented out when --author is set
    expect(generated).toMatch(/^author:\s*$/m);
  });

  it("title-cases the id for the human-readable title", async () => {
    await runInit({ name: "http-get-something", dir: tmpDir });
    const generated = await readFile(
      join(tmpDir, "skills", "http-get-something", "SKILL.md"),
      "utf8",
    );
    expect(generated).toContain('title: "Http Get Something"');
  });
});

describe("runInit — pack mode", () => {
  it("scaffolds a complete pack with skills/, llms.txt, README, .gitignore, CI", async () => {
    const result = await runInit({ name: "my-pack", pack: true, dir: tmpDir });

    expect(result.mode).toBe("pack");
    const expected = [
      join("skills", "hello-world", "SKILL.md"),
      "llms.txt",
      "README.md",
      ".gitignore",
      join(".github", "workflows", "validate.yml"),
    ];
    expect(result.files_written.sort()).toEqual(expected.sort());

    // Contents sanity-check
    const llms = await readFile(join(tmpDir, "my-pack", "llms.txt"), "utf8");
    expect(llms).toContain("my-pack");
    const readme = await readFile(join(tmpDir, "my-pack", "README.md"), "utf8");
    expect(readme).toContain("my-pack");
    const ci = await readFile(
      join(tmpDir, "my-pack", ".github", "workflows", "validate.yml"),
      "utf8",
    );
    expect(ci).toContain("agent-skills publish --check-only");
  });

  it("the scaffolded pack is publish-ready: runPublish succeeds on it", async () => {
    await runInit({ name: "my-pack", pack: true, dir: tmpDir });

    // Run publish on the scaffolded pack — should succeed with 1 added skill.
    const result = await runPublish({
      dir: join(tmpDir, "my-pack"),
      repo: "github.com/test/my-pack",
      ref: "v1.0.0",
    });

    expect(result.added).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.index_written).toBe(true);
  });

  it("after first publish, a re-publish on the scaffolded pack is byte-identical no-op", async () => {
    await runInit({ name: "my-pack", pack: true, dir: tmpDir });

    await runPublish({
      dir: join(tmpDir, "my-pack"),
      repo: "github.com/test/my-pack",
      ref: "v1.0.0",
    });
    const first = await readFile(
      join(tmpDir, "my-pack", "skills-index.json"),
      "utf8",
    );

    const second = await runPublish({
      dir: join(tmpDir, "my-pack"),
      repo: "github.com/test/my-pack",
      ref: "v1.0.0",
    });
    expect(second.unchanged).toBe(1);
    expect(second.index_changed).toBe(false);
    expect(second.index_written).toBe(false);

    const after = await readFile(
      join(tmpDir, "my-pack", "skills-index.json"),
      "utf8",
    );
    expect(after).toBe(first);
  });

  it("refuses to overwrite an existing pack file without --force", async () => {
    await runInit({ name: "my-pack", pack: true, dir: tmpDir });

    const second = await runInit({ name: "my-pack", pack: true, dir: tmpDir });
    expect(second.files_written).toEqual([]);
    expect(second.files_skipped.length).toBe(5);
  });

  it("--force overwrites existing pack files", async () => {
    await runInit({ name: "my-pack", pack: true, dir: tmpDir, authorName: "Alice" });
    const second = await runInit({
      name: "my-pack",
      pack: true,
      dir: tmpDir,
      authorName: "Bob",
      force: true,
    });
    expect(second.files_written.length).toBe(5);
    expect(second.files_skipped).toEqual([]);

    const llms = await readFile(join(tmpDir, "my-pack", "llms.txt"), "utf8");
    expect(llms).toContain("Bob");
    expect(llms).not.toContain("Alice");
  });

  it("rejects pack names with invalid characters", async () => {
    await expect(
      runInit({ name: "my pack", pack: true, dir: tmpDir }),
    ).rejects.toThrow(/must match/);
    await expect(
      runInit({ name: "../malicious", pack: true, dir: tmpDir }),
    ).rejects.toThrow(/must match/);
  });
});

describe("runInit — output structure", () => {
  it("provides next-step suggestions on success", async () => {
    const result = await runInit({ name: "alpha", dir: tmpDir });
    expect(result.next_steps.length).toBeGreaterThan(0);
    expect(result.next_steps.some((s) => s.includes("agent-skills publish"))).toBe(true);
  });

  it("when everything was skipped, suggests --force", async () => {
    await runInit({ name: "alpha", dir: tmpDir });
    const result = await runInit({ name: "alpha", dir: tmpDir });
    expect(result.next_steps.some((s) => s.toLowerCase().includes("force"))).toBe(true);
  });
});
