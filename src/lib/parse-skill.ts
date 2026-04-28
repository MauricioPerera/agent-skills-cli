// Parses a SKILL.md file into typed frontmatter + raw markdown body.
// Per agent-skills SPEC.md §2 — YAML 1.2 frontmatter, CommonMark body.

import { parse as parseYaml } from "yaml";
import type { ParsedSkill, SkillFrontmatter } from "../types.js";
import { CliError, EXIT } from "./errors.js";

/**
 * Splits a SKILL.md text into the YAML frontmatter source and the markdown body.
 *
 * Frontmatter is delimited by lines containing exactly `---` at the start and
 * end. The first `---` MUST be on the first line of the file (or the first
 * non-empty line after a UTF-8 BOM).
 */
const splitFrontmatter = (text: string): { yaml: string; body: string } => {
  // Strip UTF-8 BOM if present
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  // Normalize line endings to \n for matching
  const normalized = stripped.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // Find first `---` (allow leading blank lines)
  let firstDelim = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    if (line === "---") {
      firstDelim = i;
      break;
    }
    // Non-blank, non-delimiter line before any `---` → no frontmatter
    throw new CliError(
      EXIT.USAGE,
      "SKILL.md must start with `---` frontmatter delimiter (preceded only by blank lines)",
    );
  }
  if (firstDelim < 0) {
    throw new CliError(EXIT.USAGE, "SKILL.md is empty or has no frontmatter");
  }

  // Find closing `---`
  let closeDelim = -1;
  for (let i = firstDelim + 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeDelim = i;
      break;
    }
  }
  if (closeDelim < 0) {
    throw new CliError(EXIT.USAGE, "SKILL.md frontmatter is not terminated by closing `---`");
  }

  const yaml = lines.slice(firstDelim + 1, closeDelim).join("\n");
  const body = lines.slice(closeDelim + 1).join("\n");
  return { yaml, body };
};

/**
 * Parse a SKILL.md text into a typed ParsedSkill.
 *
 * Throws CliError(EXIT.USAGE) on:
 *   - missing or malformed frontmatter delimiters
 *   - unparseable YAML
 *   - frontmatter that does not deserialize to an object
 *
 * Does NOT validate against the JSON schema; that's lib/validate.ts.
 */
export const parseSkillSource = (source: string): ParsedSkill => {
  const { yaml, body } = splitFrontmatter(source);

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml, { strict: true, version: "1.2" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.USAGE, `frontmatter YAML parse error: ${msg}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(EXIT.USAGE, "frontmatter must be a YAML mapping (object)");
  }

  // We do NOT enforce required fields here; that's the validator's job.
  // We DO type-cast: AJV will catch shape mismatches with proper errors.
  return {
    frontmatter: parsed as SkillFrontmatter,
    body: body.replace(/^\n+/, ""), // strip leading newlines from body
  };
};

export { splitFrontmatter };
