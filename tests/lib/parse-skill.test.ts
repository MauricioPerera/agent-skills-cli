import { describe, expect, it } from "vitest";
import { parseSkillSource, splitFrontmatter } from "../../src/lib/parse-skill.js";

const MIN_VALID = `---
schema_version: "0.1"
id: "min"
version: "1.0.0"
title: "Minimal skill"
description: "A minimal valid skill for tests."
use_when: "for unit testing the parser"
command_template: "echo {msg}"
args:
  msg:
    type: string
---

# Body

Hello world.
`;

describe("splitFrontmatter — happy path", () => {
  it("splits a minimal valid file", () => {
    const { yaml, body } = splitFrontmatter(MIN_VALID);
    expect(yaml).toContain("schema_version");
    expect(yaml).toContain("command_template");
    expect(body).toContain("# Body");
  });

  it("strips UTF-8 BOM", () => {
    const withBom = "﻿" + MIN_VALID;
    const { yaml } = splitFrontmatter(withBom);
    expect(yaml).toContain("schema_version");
  });

  it("normalizes CRLF to LF", () => {
    const crlf = MIN_VALID.replace(/\n/g, "\r\n");
    const { yaml, body } = splitFrontmatter(crlf);
    expect(yaml).toContain("schema_version");
    expect(body).toContain("# Body");
  });

  it("allows leading blank lines before opening ---", () => {
    const { yaml } = splitFrontmatter("\n\n" + MIN_VALID);
    expect(yaml).toContain("schema_version");
  });
});

describe("splitFrontmatter — error cases", () => {
  it("rejects empty input", () => {
    expect(() => splitFrontmatter("")).toThrow(/empty or has no frontmatter/);
  });

  it("rejects missing opening ---", () => {
    expect(() => splitFrontmatter("schema_version: 0.1\n---\n")).toThrow(/must start with/);
  });

  it("rejects missing closing ---", () => {
    expect(() => splitFrontmatter("---\nschema_version: 0.1\n")).toThrow(/not terminated/);
  });

  it("rejects content before opening ---", () => {
    expect(() =>
      splitFrontmatter("not a delimiter\n---\nschema_version: 0.1\n---\n"),
    ).toThrow(/must start with/);
  });
});

describe("parseSkillSource", () => {
  it("returns typed frontmatter + body", () => {
    const skill = parseSkillSource(MIN_VALID);
    expect(skill.frontmatter.schema_version).toBe("0.1");
    expect(skill.frontmatter.id).toBe("min");
    expect(skill.frontmatter.command_template).toBe("echo {msg}");
    expect(skill.frontmatter.args?.msg?.type).toBe("string");
    expect(skill.body).toContain("# Body");
    expect(skill.body).toContain("Hello world.");
  });

  it("strips leading newlines from body", () => {
    const skill = parseSkillSource(MIN_VALID);
    expect(skill.body.startsWith("\n")).toBe(false);
    expect(skill.body.startsWith("# Body")).toBe(true);
  });

  it("rejects non-object frontmatter (array)", () => {
    const arr = `---
- one
- two
---
body`;
    expect(() => parseSkillSource(arr)).toThrow(/must be a YAML mapping/);
  });

  it("rejects malformed YAML in frontmatter", () => {
    const broken = `---
key: : :
---
body`;
    expect(() => parseSkillSource(broken)).toThrow(/YAML parse error/);
  });

  it("preserves complex YAML structures (nested args)", () => {
    const complex = `---
schema_version: "0.1"
id: "complex"
version: "1.0.0"
title: "Complex"
description: "complex skill"
use_when: "testing nested structures"
command_template: "echo {nested}"
args:
  nested:
    type: object
    properties:
      a:
        type: integer
      b:
        type: string
        enum: ["x", "y"]
---`;
    const skill = parseSkillSource(complex);
    expect(skill.frontmatter.args?.nested?.type).toBe("object");
    expect(skill.frontmatter.args?.nested?.properties?.a?.type).toBe("integer");
    expect(skill.frontmatter.args?.nested?.properties?.b?.enum).toEqual(["x", "y"]);
  });

  it("body is empty string when no body content", () => {
    const noBody = `---
schema_version: "0.1"
id: "x"
version: "1.0.0"
title: "x"
description: "x"
use_when: "x"
command_template: "x"
---`;
    const skill = parseSkillSource(noBody);
    expect(skill.body).toBe("");
  });
});
