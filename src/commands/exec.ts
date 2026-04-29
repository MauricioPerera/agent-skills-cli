// `agent-skills exec <skill-id> --args '<json>'` — resolve placeholders
// against arg values, spawn bash, capture I/O, append audit entry.
//
// This closes the agent-skills loop. The agent has already:
//   1. Embedded its intent.
//   2. Queried the bank → got back a skill identity.
// And now wants to actually run that skill.
//
// Privacy invariant (SPEC §8 P1): the bash subprocess inherits the parent's
// env. `command_template` references like $STRIPE_KEY are expanded by the
// SHELL at exec time, not by the bank. The CLI never sees the credential.

import type { AuditEntry, FileBank, IndexedSkill } from "../lib/bank.js";
import type { SkillFrontmatter } from "../types.js";
import { CliError, EXIT } from "../lib/errors.js";
import { resolveCommand } from "../lib/substitute.js";
import { validateSkill } from "../lib/validate.js";
import { createBashRuntime, runBashCommand } from "../lib/runtime.js";

/**
 * Strip bank-managed fields from an IndexedSkill, leaving only the original
 * SKILL.md frontmatter. Used to re-run JSON-Schema + spec-constraint
 * validation at exec time without the schema rejecting bank metadata as
 * `additionalProperties`.
 *
 * Bank-managed fields (per SPEC §9 reserved names): identity, provenance,
 * embedding, embedding_model, inserted_at, updated_at, deprecated, removed,
 * usage_count, avg_rating.
 */
const extractFrontmatter = (skill: IndexedSkill): SkillFrontmatter => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    identity, provenance, embedding, embedding_model,
    inserted_at, updated_at, deprecated, removed, usage_count, avg_rating,
    ...frontmatter
  } = skill as IndexedSkill & {
    deprecated?: boolean;
    removed?: boolean;
    usage_count?: number;
    avg_rating?: number | null;
  };
  return frontmatter as SkillFrontmatter;
};

export interface ExecOptions {
  bank: FileBank;
  /** Either a full identity (`<source>@<ref>/<path>`) or a short id (`http-get`). */
  skillIdentifier: string;
  args: Record<string, unknown>;
  /** If true, validate + resolve but DO NOT execute. Default: false. */
  dryRun?: boolean;
  /** Hard timeout in seconds. Default: 60. */
  timeoutSec?: number;
  /** If true, do NOT append an audit entry (useful for tests or noise reduction). Default: false. */
  noAudit?: boolean;
  /** Optional: original natural-language intent (recorded in audit). */
  intent?: string;
  /**
   * Optional: tenant identifier (recorded in audit; v0.12.0+).
   * Used by multi-tenant bank deployments to scope intent-conditional
   * rerank per user. See SPEC §4.5.1.
   */
  tenant?: string;
}

export interface ExecResult {
  skill_identity: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
  dry_run: boolean;
}

/**
 * Run the substituted `command_template` via the just-bash runtime
 * (per SPEC §4.4 + IMPLEMENTATION.md "exec-skill.sh"). The host shell
 * is NOT invoked — execution happens inside just-bash's AST interpreter
 * with the just-bash-data `db`/`vec` commands available.
 *
 * Per SPEC §4.4 sandbox model, env access is scoped to the skill's
 * declared `required_env ∪ optional_env`. This preserves the P1 invariant
 * (SPEC §8 + SECURITY.md §P1) — the host's `$STRIPE_KEY` etc. are
 * substituted by the shell at exec time only when the skill declared
 * them, and never reach the LLM context.
 */
const runBash = async (
  command: string,
  timeoutSec: number,
  envWhitelist: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string; elapsed_ms: number; timed_out: boolean }> => {
  // One Bash instance per exec call. Stateless across invocations (which
  // matches the previous spawn-per-exec semantics). Storage migration to
  // a long-lived bank-scoped Bash instance is a follow-up commit.
  const bash = createBashRuntime();
  // Forward only the env vars the skill declared; just-bash provides its
  // own PATH/HOME defaults, which we don't override.
  const env: Record<string, string> = {};
  for (const name of envWhitelist) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  return runBashCommand(bash, command, timeoutSec, { env });
};

/**
 * Redact arg values whose schema declares `sensitive: true`. Used in audit
 * records so secrets aren't preserved in plaintext on disk.
 */
const redactArgs = (
  args: Record<string, unknown>,
  argSpecs: Record<string, { sensitive?: boolean }> | undefined,
): Record<string, unknown> => {
  if (!argSpecs) return args;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (argSpecs[name]?.sensitive === true) {
      out[name] = "<redacted>";
    } else {
      out[name] = value;
    }
  }
  return out;
};

export const runExec = async (opts: ExecOptions): Promise<ExecResult> => {
  // 1. Resolve the user's input to a skill in the bank
  const skill = await opts.bank.resolveIdentifier(opts.skillIdentifier);

  // 2. Re-validate (defense in depth — the skill should already be valid
  //    since sync rejected invalid ones, but a stale bank or manual edit
  //    could introduce drift). We strip bank-managed fields first so the
  //    JSON Schema sees only the original SKILL.md frontmatter shape.
  const frontmatter = extractFrontmatter(skill);
  const validation = validateSkill(frontmatter);
  if (!validation.valid) {
    throw new CliError(
      EXIT.VALIDATION,
      `skill ${skill.identity} failed re-validation:\n${validation.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  }

  // 3. Resolve placeholders into a runnable command
  const resolved = resolveCommand(frontmatter, opts.args);

  // 4. Dry-run: print + exit without executing
  if (opts.dryRun === true) {
    return {
      skill_identity: skill.identity,
      command: resolved.command,
      exit_code: 0,
      stdout: "",
      stderr: "",
      elapsed_ms: 0,
      timed_out: false,
      dry_run: true,
    };
  }

  // 5. Execute via just-bash with a timeout, scoping env access to the
  //    skill's declared required_env ∪ optional_env per SPEC §4.4.
  const timeoutSec = opts.timeoutSec ?? 60;
  const envWhitelist = [
    ...(frontmatter.required_env ?? []),
    ...(frontmatter.optional_env ?? []),
  ];
  const result = await runBash(resolved.command, timeoutSec, envWhitelist);

  // 6. Audit (unless --no-audit)
  if (opts.noAudit !== true) {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      skill_id: skill.identity,
      args: redactArgs(opts.args, skill.args),
      exit_code: result.exit_code,
      elapsed_ms: result.elapsed_ms,
      stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
      stderr_bytes: Buffer.byteLength(result.stderr, "utf8"),
    };
    if (opts.intent !== undefined) entry.intent = opts.intent;
    if (opts.tenant !== undefined) entry.tenant = opts.tenant;
    await opts.bank.appendAudit(entry);
  }

  return {
    skill_identity: skill.identity,
    command: resolved.command,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsed_ms: result.elapsed_ms,
    timed_out: result.timed_out,
    dry_run: false,
  };
};

export const printExecResult = (result: ExecResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  // In plain mode, just write stdout to stdout and stderr to stderr; that
  // way piping (`agent-skills exec ... | jq ...`) works as expected.
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.timed_out) {
    process.stderr.write(`\n[agent-skills] killed by timeout after ${result.elapsed_ms}ms\n`);
  }
};
