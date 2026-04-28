// `agent-skills resolve <file> --args '<json>'` — substitute placeholders
// against arg values and print the resolved bash command. Does NOT execute.
//
// Useful for debugging, dry-run, audit logging, and CI checks.

import { readFile } from "node:fs/promises";
import { CliError, EXIT } from "../lib/errors.js";
import { parseSkillSource } from "../lib/parse-skill.js";
import { resolveCommand, type ResolveResult } from "../lib/substitute.js";
import { validateSkill } from "../lib/validate.js";

export interface ResolveOptions {
  file: string;
  argsJson: string;
  json?: boolean;
  skipValidation?: boolean;
}

export interface ResolveOutput extends ResolveResult {
  file: string;
}

export const runResolve = async (
  opts: ResolveOptions,
): Promise<ResolveOutput> => {
  let source: string;
  try {
    source = await readFile(opts.file, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.NOT_FOUND, `cannot read file: ${msg}`);
  }

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(opts.argsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--args must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.USAGE, `invalid --args JSON: ${msg}`);
  }

  const skill = parseSkillSource(source);

  if (!opts.skipValidation) {
    const validation = validateSkill(skill.frontmatter);
    if (!validation.valid) {
      const summary = validation.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join("\n");
      throw new CliError(
        EXIT.VALIDATION,
        `skill is non-conformant; resolve refused. Errors:\n${summary}\nUse --skip-validation to bypass (not recommended).`,
      );
    }
  }

  const result = resolveCommand(skill.frontmatter, args);
  return {
    file: opts.file,
    command: result.command,
    trace: result.trace,
  };
};

export const printResolveResult = (
  result: ResolveOutput,
  asJson: boolean,
): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  // Plain mode: just print the command. Suitable for piping into bash.
  process.stdout.write(result.command + "\n");
};
