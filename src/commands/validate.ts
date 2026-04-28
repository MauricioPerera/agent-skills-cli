// `agent-skills validate <file>` — validate a SKILL.md against the spec.

import { readFile } from "node:fs/promises";
import { CliError, EXIT } from "../lib/errors.js";
import { parseSkillSource } from "../lib/parse-skill.js";
import { validateSkill } from "../lib/validate.js";

export interface ValidateOptions {
  file: string;
  json?: boolean;
}

export interface ValidateResult {
  file: string;
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export const runValidate = async (
  opts: ValidateOptions,
): Promise<ValidateResult> => {
  let source: string;
  try {
    source = await readFile(opts.file, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.NOT_FOUND, `cannot read file: ${msg}`);
  }

  const parsed = parseSkillSource(source);
  const result = validateSkill(parsed.frontmatter);

  return {
    file: opts.file,
    valid: result.valid,
    errors: result.errors,
  };
};

export const printValidateResult = (
  result: ValidateResult,
  asJson: boolean,
): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (result.valid) {
    process.stdout.write(`✓ ${result.file} is conformant\n`);
    return;
  }

  process.stdout.write(`✗ ${result.file} has ${result.errors.length} error(s):\n`);
  for (const err of result.errors) {
    process.stdout.write(`  ${err.path}: ${err.message}\n`);
  }
};
