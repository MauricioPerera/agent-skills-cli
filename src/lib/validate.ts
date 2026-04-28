// Schema validation per agent-skills SPEC.md §2 + the bundled JSON Schema.
// Uses AJV (Draft 2020-12).

import _Ajv from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

// AJV's ESM bindings publish their main constructor under `.default` on
// some package layouts and as the module default on others. Normalize.
const Ajv2020 = (_Ajv as unknown as { default?: typeof _Ajv }).default ?? _Ajv;
const addFormats = (_addFormats as unknown as { default?: typeof _addFormats }).default ?? _addFormats;
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillFrontmatter } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled skill.schema.json. Searches:
 *   1. Adjacent to the running module (./schemas/skill.schema.json relative to dist/).
 *   2. The package's schemas/ directory (when running from source).
 */
const loadBundledSchema = (): unknown => {
  const candidates = [
    join(__dirname, "..", "schemas", "skill.schema.json"),       // dist layout
    join(__dirname, "..", "..", "schemas", "skill.schema.json"), // source layout
  ];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      return JSON.parse(text);
    } catch {
      // try next
    }
  }
  throw new Error(
    "could not locate skill.schema.json; checked: " + candidates.join(", "),
  );
};

let validatorCache: ValidateFunction | null = null;

const getValidator = (): ValidateFunction => {
  if (validatorCache !== null) return validatorCache;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = loadBundledSchema();
  const compiled = ajv.compile(schema as object);
  validatorCache = compiled;
  return compiled;
};

export interface ValidationError {
  path: string; // JSON pointer-like path into the document
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const formatError = (e: ErrorObject): ValidationError => {
  // AJV's instancePath is JSON-pointer style. Convert "/foo/bar" → "foo.bar"
  // for human readability; keep "" → "<root>".
  const path = e.instancePath
    ? e.instancePath.replace(/^\//, "").replace(/\//g, ".")
    : "<root>";
  return { path, message: e.message ?? "unknown validation error" };
};

/**
 * Validate parsed frontmatter against the bundled JSON schema.
 *
 * Returns a structured result; never throws on validation failure.
 * Throws only on internal errors (schema not loadable, etc.).
 */
export const validateFrontmatter = (
  frontmatter: SkillFrontmatter | unknown,
): ValidationResult => {
  const validate = getValidator();
  const valid = validate(frontmatter);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors ?? []).map(formatError);
  return { valid: false, errors };
};

/**
 * Additional checks beyond JSON Schema that the spec requires but AJV cannot
 * easily express. Run AFTER validateFrontmatter.
 *
 *   1. command_template must NOT have a {placeholder} immediately preceded
 *      or followed by a literal " or ' character (SPEC §2.6).
 *   2. unquoted args must have a pattern that rejects shell metacharacters
 *      (SPEC §2.6, schema enforces the existence of `pattern` but not its content).
 *   3. Every {placeholder} in command_template must have a corresponding
 *      entry in `args` (or be a chain output_var).
 */
export const validateSpecConstraints = (
  fm: SkillFrontmatter,
): ValidationResult => {
  const errors: ValidationError[] = [];

  // Check 1: placeholders adjacent to literal quotes.
  // We scan command_template for {name} occurrences and check the chars
  // immediately before and after.
  const tpl = fm.command_template ?? "";
  const placeholderRe = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = placeholderRe.exec(tpl)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const charBefore = start > 0 ? tpl[start - 1] : "";
    const charAfter = end < tpl.length ? tpl[end] : "";

    // Detect literal-string adjacency. Note: $(...) is command substitution,
    // not a literal string. We crude-check by walking back from charBefore
    // through whitespace and checking if we land on `$(` (allowed) vs `"` or `'` alone (forbidden).
    if (charBefore === '"' || charBefore === "'") {
      // Heuristic: walk back to see if this quote is part of $(...)
      // For now, flag it. Banks may refine.
      errors.push({
        path: "command_template",
        message: `placeholder '${match[0]}' is preceded by literal quote character '${charBefore}' — placeholders MUST be in argument position (SPEC §2.6)`,
      });
    }
    if (charAfter === '"' || charAfter === "'") {
      errors.push({
        path: "command_template",
        message: `placeholder '${match[0]}' is followed by literal quote character '${charAfter}' — placeholders MUST be in argument position (SPEC §2.6)`,
      });
    }
  }

  // Check 2: unquoted args have a pattern that rejects shell metacharacters.
  const FORBIDDEN_METACHARS = [
    ";", "&", "|", "$", "`", "(", ")", "<", ">", "*", "?", "[", "]",
    "\\", '"', "'", "{", "}", "#", "~", " ", "\t", "\n",
  ];

  for (const [argName, argSpec] of Object.entries(fm.args ?? {})) {
    if (!argSpec.unquoted) continue;
    if (!argSpec.pattern) {
      errors.push({
        path: `args.${argName}`,
        message: "unquoted args MUST declare a pattern (SPEC §2.6)",
      });
      continue;
    }
    // Test the pattern against each forbidden metacharacter.
    let regex: RegExp;
    try {
      regex = new RegExp(argSpec.pattern);
    } catch {
      errors.push({
        path: `args.${argName}.pattern`,
        message: `pattern '${argSpec.pattern}' is not a valid regex`,
      });
      continue;
    }
    for (const ch of FORBIDDEN_METACHARS) {
      if (regex.test(ch)) {
        errors.push({
          path: `args.${argName}.pattern`,
          message: `unquoted arg pattern accepts forbidden shell metacharacter '${ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch}'`,
        });
        break; // one example is enough
      }
    }
  }

  // Check 3: every {name} placeholder in command_template has an args entry.
  const declaredArgs = new Set(Object.keys(fm.args ?? {}));
  // Chain output_vars are NOT injected as {placeholders} in command_template;
  // they only flow through chains. So we only check args coverage.
  placeholderRe.lastIndex = 0;
  while ((match = placeholderRe.exec(tpl)) !== null) {
    const argName = match[1];
    if (argName !== undefined && !declaredArgs.has(argName)) {
      errors.push({
        path: "command_template",
        message: `placeholder '${match[0]}' has no corresponding entry in args`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
};

/**
 * Run both schema validation and spec-constraint checks. Returns a combined result.
 */
export const validateSkill = (frontmatter: unknown): ValidationResult => {
  const schemaResult = validateFrontmatter(frontmatter);
  if (!schemaResult.valid) return schemaResult;

  const constraintsResult = validateSpecConstraints(frontmatter as SkillFrontmatter);
  return {
    valid: constraintsResult.valid,
    errors: [...schemaResult.errors, ...constraintsResult.errors],
  };
};
