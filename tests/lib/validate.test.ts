import { describe, expect, it } from "vitest";
import {
  validateFrontmatter,
  validateSpecConstraints,
  validateSkill,
} from "../../src/lib/validate.js";
import type { SkillFrontmatter } from "../../src/types.js";

const MIN: SkillFrontmatter = {
  schema_version: "0.1",
  id: "min",
  version: "1.0.0",
  title: "Minimal",
  description: "minimal skill",
  use_when: "for tests",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
};

describe("validateFrontmatter — happy path", () => {
  it("accepts minimal valid skill", () => {
    const r = validateFrontmatter(MIN);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts a fully-decorated skill", () => {
    const full: SkillFrontmatter = {
      ...MIN,
      license: "MIT",
      author: { name: "Test", url: "https://example.com" },
      homepage: "https://example.com",
      category: "test",
      tags: ["one", "two"],
      examples: [{ intent: "say hi", command: "echo hi" }],
      shell: "bash",
      idempotent: true,
      required_commands: ["echo"],
      required_env: ["FOO"],
      optional_env: ["DEBUG"],
      network: ["https://api.example.com/"],
      applicable_when: { os: ["linux"], arch: ["x86_64"] },
      related: ["github.com/x/y@v1/related"],
    };
    const r = validateFrontmatter(full);
    expect(r.valid).toBe(true);
  });
});

describe("validateFrontmatter — schema rejection", () => {
  it("rejects missing schema_version", () => {
    const { schema_version: _omit, ...rest } = MIN;
    const r = validateFrontmatter(rest);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("schema_version"))).toBe(true);
  });

  it("accepts schema_version '0.2' (added in spec v1.2 for the `filesystem` field)", () => {
    const r = validateFrontmatter({ ...MIN, schema_version: "0.2" });
    expect(r.valid).toBe(true);
  });

  it("rejects schema_version other than the supported set ('0.1' / '0.2')", () => {
    const r = validateFrontmatter({ ...MIN, schema_version: "9.9" });
    expect(r.valid).toBe(false);
  });

  it("rejects `filesystem` on a 0.1 skill (cross-field constraint)", () => {
    // SPEC §2.11 mandates schema_version 0.2+ for the filesystem field.
    const r = validateFrontmatter({
      ...MIN,
      schema_version: "0.1",
      filesystem: ["/etc"],
    });
    expect(r.valid).toBe(false);
  });

  it("accepts `filesystem` on a 0.2 skill", () => {
    const r = validateFrontmatter({
      ...MIN,
      schema_version: "0.2",
      filesystem: ["/etc", "/var/log"],
    });
    expect(r.valid).toBe(true);
  });

  it("rejects bad id pattern (uppercase)", () => {
    const r = validateFrontmatter({ ...MIN, id: "BadId" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === "id")).toBe(true);
  });

  it("rejects bad version (not semver)", () => {
    const r = validateFrontmatter({ ...MIN, version: "1.0" });
    expect(r.valid).toBe(false);
  });

  it("rejects title exceeding 80 bytes", () => {
    const r = validateFrontmatter({ ...MIN, title: "x".repeat(81) });
    expect(r.valid).toBe(false);
  });

  it("rejects unknown top-level field (provenance NOT allowed in file)", () => {
    const r = validateFrontmatter({ ...MIN, provenance: { source_type: "git" } });
    expect(r.valid).toBe(false);
  });

  it("rejects bad arg type", () => {
    const r = validateFrontmatter({
      ...MIN,
      args: { x: { type: "weird" as unknown as "string" } },
    });
    expect(r.valid).toBe(false);
  });

  it("rejects unquoted arg without pattern", () => {
    const r = validateFrontmatter({
      ...MIN,
      args: { x: { type: "string", unquoted: true } },
    });
    expect(r.valid).toBe(false);
  });
});

describe("validateSpecConstraints — placeholder positioning", () => {
  it("flags placeholder preceded by literal double quote", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: 'curl -d "amount={amount}"',
      args: { amount: { type: "integer" } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("literal quote"))).toBe(true);
  });

  it("flags placeholder preceded by literal single quote", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "echo 'value={msg}'",
    });
    expect(r.valid).toBe(false);
  });

  it("accepts placeholder in argument position", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "curl -d amount={amount}",
      args: { amount: { type: "integer" } },
    });
    expect(r.valid).toBe(true);
  });

  it("accepts multiple placeholders in argument position", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "curl -d a={a} -d b={b}",
      args: { a: { type: "integer" }, b: { type: "string" } },
    });
    expect(r.valid).toBe(true);
  });

  it("flags placeholder with no corresponding args entry", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "echo {undefined_arg}",
      args: {},
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("no corresponding entry in args"))).toBe(true);
  });
});

describe("validateSpecConstraints — unquoted arg patterns", () => {
  it("rejects unquoted arg with a permissive pattern", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "echo {x}",
      args: { x: { type: "string", unquoted: true, pattern: ".*" } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("forbidden shell metacharacter"))).toBe(true);
  });

  it("accepts unquoted arg with strict pattern", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "echo {x}",
      args: { x: { type: "string", unquoted: true, pattern: "^[a-zA-Z0-9_-]+$" } },
    });
    expect(r.valid).toBe(true);
  });

  it("rejects unquoted arg whose pattern allows dollar sign", () => {
    const r = validateSpecConstraints({
      ...MIN,
      command_template: "echo {x}",
      args: { x: { type: "string", unquoted: true, pattern: "^[a-zA-Z$]+$" } },
    });
    expect(r.valid).toBe(false);
  });
});

describe("validateSkill (combined)", () => {
  it("returns valid for a clean skill", () => {
    const r = validateSkill(MIN);
    expect(r.valid).toBe(true);
  });

  it("short-circuits: schema errors prevent constraint checks", () => {
    // Missing schema_version → schema fails; constraint checks aren't reached.
    const { schema_version: _, ...rest } = MIN;
    const r = validateSkill(rest);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.toLowerCase().includes("schema_version"))).toBe(true);
  });

  it("returns combined errors when both layers fail", () => {
    const broken = {
      ...MIN,
      command_template: 'echo "{undefined_arg}"',
      args: {},
    };
    const r = validateSkill(broken);
    expect(r.valid).toBe(false);
  });
});
