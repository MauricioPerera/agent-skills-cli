// Tests for `agent-skills publish` (v0.8.0).
//
// Validates the author workflow:
//   - Scan skills/<id>/SKILL.md, validate, compose skills-index.json.
//   - Hand-crafted summaries in an existing index are preserved on re-publish.
//   - Newly added skills get summary auto-generated from `description`.
//   - Skills present in old index but absent on disk are reported as removed.
//   - Idempotent: a no-op re-publish doesn't change the index file byte-for-byte.
//   - --check-only validates without writing.
//   - Validation failures abort the index write and exit non-zero.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPublish } from "../src/commands/publish.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-publish-test-"));
  await mkdir(join(tmpDir, "skills"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const writeSkill = async (
  id: string,
  fmExtras: Record<string, unknown> = {},
): Promise<void> => {
  await mkdir(join(tmpDir, "skills", id), { recursive: true });
  const fm = {
    schema_version: "0.1",
    id,
    version: "1.0.0",
    title: `Skill ${id}`,
    description: `${id} skill description`,
    use_when: `you want ${id}`,
    command_template: "echo {x}",
    args: { x: { type: "string" } },
    license: "MIT",
    ...fmExtras,
  };
  // Render YAML by hand — simple cases only, avoids pulling in yaml in tests.
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (typeof v === "string") return `${k}: ${JSON.stringify(v)}`;
      if (typeof v === "object" && v !== null) {
        if (k === "args") {
          return `args:\n  x:\n    type: string`;
        }
        return `${k}: ${JSON.stringify(v)}`;
      }
      return `${k}: ${v}`;
    })
    .join("\n");
  await writeFile(
    join(tmpDir, "skills", id, "SKILL.md"),
    `---\n${yaml}\n---\n\n# ${id}\n`,
    "utf8",
  );
};

const writeIndex = async (index: object): Promise<void> => {
  await writeFile(
    join(tmpDir, "skills-index.json"),
    JSON.stringify(index, null, 2) + "\n",
    "utf8",
  );
};

const readIndex = async (): Promise<{
  schema_version: string;
  publisher?: Record<string, unknown>;
  default_source?: Record<string, unknown>;
  url_template?: string;
  skills: Array<{ id: string; version: string; url?: string; summary?: string }>;
}> => {
  const text = await readFile(join(tmpDir, "skills-index.json"), "utf8");
  return JSON.parse(text);
};

describe("runPublish — first-time publish", () => {
  it("scans skills/, generates index with summary defaulting to description", async () => {
    await writeSkill("alpha");
    await writeSkill("bravo");

    const result = await runPublish({
      dir: tmpDir,
      repo: "github.com/test/pack",
      ref: "v1.0.0",
    });

    expect(result.added).toBe(2);
    expect(result.invalid).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.index_written).toBe(true);
    expect(result.index_changed).toBe(true);

    const index = await readIndex();
    expect(index.schema_version).toBe("0.1");
    expect(index.skills).toHaveLength(2);
    expect(index.skills[0]?.id).toBe("alpha");
    expect(index.skills[0]?.version).toBe("1.0.0");
    expect(index.skills[0]?.summary).toBe("alpha skill description");
    // jsDelivr URL strips the `github.com/` prefix → `gh/{owner}/{repo}@{ref}/...`
    expect(index.skills[0]?.url).toContain("gh/test/pack@v1.0.0");
    expect(index.skills[0]?.url).toContain("/alpha/SKILL.md");

    expect(index.url_template).toContain("{ref}");
    expect(index.url_template).toContain("{path}");
    expect(index.default_source?.["repo"]).toBe("github.com/test/pack");
  });

  it("infers jsDelivr template for github.com repos", async () => {
    await writeSkill("alpha");

    const result = await runPublish({
      dir: tmpDir,
      repo: "github.com/me/my-pack",
      ref: "v1.0.0",
    });

    const index = await readIndex();
    expect(index.url_template).toBe(
      "https://cdn.jsdelivr.net/gh/me/my-pack@{ref}/skills/{path}/SKILL.md",
    );
    expect(result.added).toBe(1);
  });

  it("infers gitlab template for gitlab.com repos", async () => {
    await writeSkill("alpha");

    await runPublish({
      dir: tmpDir,
      repo: "gitlab.com/me/my-pack",
      ref: "v1.0.0",
    });

    const index = await readIndex();
    expect(index.url_template).toBe(
      "https://gitlab.com/me/my-pack/-/raw/{ref}/skills/{path}/SKILL.md",
    );
  });
});

describe("runPublish — re-publish preserves hand-crafted summaries", () => {
  it("preserves existing summary when re-publishing the same skill", async () => {
    await writeSkill("alpha");
    await writeIndex({
      schema_version: "0.1",
      publisher: { name: "Alice" },
      default_source: { type: "git", repo: "github.com/test/pack", latest_release: "v1.0.0" },
      url_template: "https://cdn.jsdelivr.net/gh/test/pack@{ref}/skills/{path}/SKILL.md",
      skills: [
        {
          id: "alpha",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/alpha/SKILL.md",
          summary: "Hand-crafted alpha summary with extra polish.",
        },
      ],
    });

    const result = await runPublish({ dir: tmpDir });

    expect(result.unchanged).toBe(1);
    expect(result.index_changed).toBe(false);
    const index = await readIndex();
    expect(index.skills[0]?.summary).toBe("Hand-crafted alpha summary with extra polish.");
  });

  it("auto-summary for newly added skill, hand-summary preserved for existing", async () => {
    await writeSkill("alpha");
    await writeSkill("bravo"); // newly added

    await writeIndex({
      schema_version: "0.1",
      publisher: { name: "Alice" },
      default_source: { type: "git", repo: "github.com/test/pack", latest_release: "v1.0.0" },
      url_template: "https://cdn.jsdelivr.net/gh/test/pack@{ref}/skills/{path}/SKILL.md",
      skills: [
        {
          id: "alpha",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/alpha/SKILL.md",
          summary: "Hand-crafted alpha summary.",
        },
      ],
    });

    const result = await runPublish({ dir: tmpDir });

    expect(result.added).toBe(1); // bravo
    expect(result.unchanged).toBe(1); // alpha
    expect(result.index_changed).toBe(true);

    const index = await readIndex();
    const alpha = index.skills.find((s) => s.id === "alpha");
    const bravo = index.skills.find((s) => s.id === "bravo");
    expect(alpha?.summary).toBe("Hand-crafted alpha summary.");
    expect(bravo?.summary).toBe("bravo skill description");
  });

  it("preserves publisher metadata on re-publish", async () => {
    await writeSkill("alpha");
    await writeIndex({
      schema_version: "0.1",
      publisher: {
        name: "Alice",
        domain: "alice.dev",
        github_org: "alicedev",
        homepage: "https://alice.dev",
      },
      default_source: { type: "git", repo: "github.com/test/pack", latest_release: "v1.0.0" },
      url_template: "https://cdn.jsdelivr.net/gh/test/pack@{ref}/skills/{path}/SKILL.md",
      skills: [{ id: "alpha", version: "1.0.0", summary: "summary" }],
    });

    await runPublish({ dir: tmpDir });

    const index = await readIndex();
    expect(index.publisher).toEqual({
      name: "Alice",
      domain: "alice.dev",
      github_org: "alicedev",
      homepage: "https://alice.dev",
    });
  });

  it("reports skills removed from disk that were in the old index", async () => {
    await writeSkill("alpha");
    // bravo was in index but no longer on disk
    await writeIndex({
      schema_version: "0.1",
      default_source: { type: "git", repo: "github.com/test/pack", latest_release: "v1.0.0" },
      url_template: "https://cdn.jsdelivr.net/gh/test/pack@{ref}/skills/{path}/SKILL.md",
      skills: [
        {
          id: "alpha",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/alpha/SKILL.md",
          summary: "alpha skill description",
        },
        {
          id: "bravo",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/bravo/SKILL.md",
          summary: "bravo summary",
        },
      ],
    });

    const result = await runPublish({ dir: tmpDir });

    expect(result.removed).toEqual(["bravo"]);
    // alpha is unchanged (existing entry matched), bravo removed → no on-disk skills
    // are added/updated.
    expect(result.unchanged).toBe(1);
    const index = await readIndex();
    expect(index.skills.map((s) => s.id)).toEqual(["alpha"]);
  });
});

describe("runPublish — ordering", () => {
  it("preserves the existing index's skill order; appends new skills sorted at the end", async () => {
    // On disk: alpha, bravo, charlie (alphabetical)
    await writeSkill("alpha");
    await writeSkill("bravo");
    await writeSkill("charlie");

    // Existing index has CURATED order: charlie, alpha, bravo
    await writeIndex({
      schema_version: "0.1",
      default_source: { type: "git", repo: "github.com/test/pack", latest_release: "v1.0.0" },
      url_template: "https://cdn.jsdelivr.net/gh/test/pack@{ref}/skills/{path}/SKILL.md",
      skills: [
        {
          id: "charlie",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/charlie/SKILL.md",
          summary: "charlie skill description",
        },
        {
          id: "alpha",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/alpha/SKILL.md",
          summary: "alpha skill description",
        },
        {
          id: "bravo",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/bravo/SKILL.md",
          summary: "bravo skill description",
        },
      ],
    });

    const result = await runPublish({ dir: tmpDir });

    // No changes: all three present, all matching
    expect(result.unchanged).toBe(3);
    expect(result.index_changed).toBe(false);

    const index = await readIndex();
    // Curated order preserved!
    expect(index.skills.map((s) => s.id)).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("appends new skills to the end of the existing curated order, alphabetically", async () => {
    // On disk: alpha, bravo, delta, echo (echo and delta NEW)
    await writeSkill("alpha");
    await writeSkill("bravo");
    await writeSkill("delta");
    await writeSkill("echo");

    // Existing index curated: bravo, alpha (intentionally not alphabetical)
    await writeIndex({
      schema_version: "0.1",
      default_source: { type: "git", repo: "github.com/test/pack", latest_release: "v1.0.0" },
      url_template: "https://cdn.jsdelivr.net/gh/test/pack@{ref}/skills/{path}/SKILL.md",
      skills: [
        {
          id: "bravo",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/bravo/SKILL.md",
          summary: "bravo skill description",
        },
        {
          id: "alpha",
          version: "1.0.0",
          url: "https://cdn.jsdelivr.net/gh/test/pack@v1.0.0/skills/alpha/SKILL.md",
          summary: "alpha skill description",
        },
      ],
    });

    const result = await runPublish({ dir: tmpDir });

    expect(result.added).toBe(2); // delta, echo
    expect(result.unchanged).toBe(2); // bravo, alpha

    const index = await readIndex();
    // bravo,alpha first (preserving curation), then delta,echo alphabetically
    expect(index.skills.map((s) => s.id)).toEqual(["bravo", "alpha", "delta", "echo"]);
  });
});

describe("runPublish — idempotence", () => {
  it("running publish twice on an unchanged tree is a no-op the second time", async () => {
    await writeSkill("alpha");
    await writeSkill("bravo");

    await runPublish({
      dir: tmpDir,
      repo: "github.com/test/pack",
      ref: "v1.0.0",
    });
    const firstBytes = await readFile(join(tmpDir, "skills-index.json"), "utf8");

    const second = await runPublish({ dir: tmpDir });
    const secondBytes = await readFile(join(tmpDir, "skills-index.json"), "utf8");

    expect(second.unchanged).toBe(2);
    expect(second.index_changed).toBe(false);
    expect(second.index_written).toBe(false);
    expect(firstBytes).toBe(secondBytes); // byte-for-byte
  });

  it("changing a SKILL.md version marks it 'updated' and rewrites the index", async () => {
    await writeSkill("alpha");
    await runPublish({
      dir: tmpDir,
      repo: "github.com/test/pack",
      ref: "v1.0.0",
    });

    // Bump version on disk
    await writeSkill("alpha", { version: "1.1.0" });

    const result = await runPublish({ dir: tmpDir });

    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.index_changed).toBe(true);
  });
});

describe("runPublish — validation failures", () => {
  it("refuses to write index when any SKILL.md is invalid", async () => {
    await writeSkill("good");

    // A SKILL.md that parses but fails schema validation: missing
    // command_template (a required field per SPEC §2.2).
    await mkdir(join(tmpDir, "skills", "broken"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "broken", "SKILL.md"),
      `---
schema_version: "0.1"
id: "broken"
version: "1.0.0"
title: "Broken skill"
description: "missing command_template"
use_when: "never"
---

# broken
`,
      "utf8",
    );

    const result = await runPublish({
      dir: tmpDir,
      repo: "github.com/test/pack",
      ref: "v1.0.0",
    });

    expect(result.invalid).toBeGreaterThan(0);
    expect(result.index_written).toBe(false);
    const broken = result.skills.find((s) => s.id === "broken");
    expect(broken?.status).toBe("invalid");
    expect(broken?.errors).toBeDefined();
    expect(broken?.errors?.length).toBeGreaterThan(0);
  });

  it("--check-only never writes even when valid", async () => {
    await writeSkill("alpha");
    const result = await runPublish({
      dir: tmpDir,
      repo: "github.com/test/pack",
      ref: "v1.0.0",
      checkOnly: true,
    });

    expect(result.added).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.index_changed).toBe(true);   // would change
    expect(result.index_written).toBe(false);  // but didn't write

    // Confirm no file on disk
    await expect(readIndex()).rejects.toThrow();
  });
});

describe("runPublish — error paths", () => {
  it("throws CliError when skills/ doesn't exist", async () => {
    await rm(join(tmpDir, "skills"), { recursive: true });
    await expect(runPublish({ dir: tmpDir })).rejects.toThrow(
      /does not exist.*skills/is, // multi-line / cross-platform paths
    );
  });

  it("throws CliError when existing skills-index.json is malformed", async () => {
    await writeSkill("alpha");
    await writeFile(join(tmpDir, "skills-index.json"), "{not json", "utf8");
    await expect(runPublish({ dir: tmpDir })).rejects.toThrow(
      /skills-index\.json is not valid JSON/i,
    );
  });

  it("returns 'error' status for a SKILL.md that fails to parse", async () => {
    await mkdir(join(tmpDir, "skills", "garbage"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "garbage", "SKILL.md"),
      "this is not yaml frontmatter at all\n",
      "utf8",
    );

    const result = await runPublish({ dir: tmpDir });
    const garbage = result.skills.find((s) => s.id === "garbage");
    expect(garbage?.status).toBe("error");
  });
});
