// Placeholder substitution per agent-skills SPEC.md §2.6.
//
// Per-type quoting policy:
//   string  → single-quoted, embedded ' encoded as '\''
//   integer → raw (no quoting; type guarantees no metacharacters)
//   number  → raw
//   boolean → literal `true` / `false`
//   array   → JSON-encoded, then single-quoted
//   object  → JSON-encoded, then single-quoted
//
// Exception: when args.<name>.unquoted: true, the value is inserted raw.
// The validator must enforce a strict pattern in this case.

import type { ArgSpec, SkillFrontmatter } from "../types.js";
import { CliError, EXIT } from "./errors.js";

/**
 * Encode a string for safe insertion as a single bash argument.
 * Uses the `'\''` idiom for embedded single quotes.
 */
const shellQuote = (s: string): string => {
  return "'" + s.replace(/'/g, "'\\''") + "'";
};

/**
 * Validate a single arg value against its spec. Throws CliError(EXIT.VALIDATION)
 * on failure with a descriptive message.
 */
const validateArgValue = (name: string, spec: ArgSpec, value: unknown): void => {
  // Type check
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        throw new CliError(
          EXIT.VALIDATION,
          `arg '${name}': expected string, got ${typeof value}`,
        );
      }
      break;
    case "integer":
      if (!Number.isInteger(value)) {
        throw new CliError(
          EXIT.VALIDATION,
          `arg '${name}': expected integer, got ${typeof value} (${String(value)})`,
        );
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CliError(
          EXIT.VALIDATION,
          `arg '${name}': expected finite number, got ${typeof value}`,
        );
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new CliError(
          EXIT.VALIDATION,
          `arg '${name}': expected boolean, got ${typeof value}`,
        );
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        throw new CliError(EXIT.VALIDATION, `arg '${name}': expected array`);
      }
      break;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CliError(EXIT.VALIDATION, `arg '${name}': expected object`);
      }
      break;
  }

  // Range
  if (spec.range && (spec.type === "integer" || spec.type === "number")) {
    const n = value as number;
    const [min, max] = spec.range;
    if (n < min || n > max) {
      throw new CliError(
        EXIT.VALIDATION,
        `arg '${name}': value ${n} out of range [${min}, ${max}]`,
      );
    }
  }

  // Enum
  if (spec.enum) {
    const ok = spec.enum.some((candidate) => candidate === value);
    if (!ok) {
      throw new CliError(
        EXIT.VALIDATION,
        `arg '${name}': value ${JSON.stringify(value)} not in enum ${JSON.stringify(spec.enum)}`,
      );
    }
  }

  // Pattern (string only)
  if (spec.pattern && spec.type === "string") {
    let regex: RegExp;
    try {
      regex = new RegExp(spec.pattern);
    } catch {
      throw new CliError(
        EXIT.VALIDATION,
        `arg '${name}': pattern '${spec.pattern}' is not a valid regex`,
      );
    }
    if (!regex.test(value as string)) {
      throw new CliError(
        EXIT.VALIDATION,
        `arg '${name}': value ${JSON.stringify(value)} does not match pattern ${spec.pattern}`,
      );
    }
  }
};

/**
 * Substitute one value for one arg, returning the shell-token form per §2.6.
 */
export const substituteValue = (spec: ArgSpec, value: unknown): string => {
  // unquoted bypass: value is inserted raw. The validator must have ensured
  // the pattern is strict.
  if (spec.unquoted) {
    return String(value);
  }

  switch (spec.type) {
    case "string":
      return shellQuote(value as string);
    case "integer":
    case "number":
      return String(value);
    case "boolean":
      return (value as boolean) ? "true" : "false";
    case "array":
    case "object":
      return shellQuote(JSON.stringify(value));
  }
};

export interface ResolveResult {
  command: string;
  /** Per-arg trace: what was substituted, how. Useful for audit / debugging. */
  trace: Array<{ name: string; type: string; rendered: string }>;
}

/**
 * Resolve a command_template with given args. The result is a single bash
 * command string ready for `bash -c` execution.
 *
 * Steps:
 *   1. Validate every required arg is present (or has a default).
 *   2. Validate types, ranges, enums, patterns.
 *   3. Substitute each {placeholder} per §2.6 quoting policy.
 *
 * Throws:
 *   - CliError(EXIT.VALIDATION) on type/range/pattern mismatch.
 *   - CliError(EXIT.USAGE) on missing required args.
 */
export const resolveCommand = (
  fm: SkillFrontmatter,
  args: Record<string, unknown>,
): ResolveResult => {
  const argSpecs = fm.args ?? {};
  const trace: ResolveResult["trace"] = [];

  // Apply defaults + validate every declared arg
  const resolved: Record<string, string> = {};
  for (const [name, spec] of Object.entries(argSpecs)) {
    let value: unknown;
    if (name in args) {
      value = args[name];
    } else if ("default" in spec && spec.default !== null && spec.default !== undefined) {
      value = spec.default;
    } else {
      throw new CliError(
        EXIT.USAGE,
        `missing required arg '${name}' (no default declared)`,
      );
    }

    validateArgValue(name, spec, value);
    const rendered = substituteValue(spec, value);
    resolved[name] = rendered;
    trace.push({ name, type: spec.type, rendered });
  }

  // Substitute into template. Only replace exact {name} for declared args.
  const tpl = fm.command_template ?? "";
  let result = tpl;
  for (const [name, rendered] of Object.entries(resolved)) {
    // Use a literal-safe find/replace; do not use regex special chars.
    result = result.split(`{${name}}`).join(rendered);
  }

  // Detect any remaining {placeholder} that was not substituted.
  const leftover = result.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/);
  if (leftover) {
    throw new CliError(
      EXIT.USAGE,
      `command_template still has unresolved placeholder ${leftover[0]} after substitution`,
    );
  }

  return { command: result, trace };
};
