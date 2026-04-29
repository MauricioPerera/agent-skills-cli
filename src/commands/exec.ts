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
import {
  cleanupScratch,
  createSandboxedExec,
  loadCustomCommandFromSource,
  runBashCommand,
} from "../lib/runtime.js";
import type { CustomCommand } from "just-bash";

/**
 * Strip bank-managed fields from an IndexedSkill, leaving only the original
 * SKILL.md frontmatter. Used to re-run JSON-Schema + spec-constraint
 * validation at exec time without the schema rejecting bank metadata as
 * `additionalProperties`.
 *
 * Bank-managed fields (per SPEC §9 reserved names): identity, provenance,
 * embedding, embedding_model, inserted_at, updated_at, deprecated, removed,
 * usage_count, avg_rating, command_source.
 *
 * NOTE: keep this list in sync with the bank-added fields on IndexedSkill
 * (see bank.ts). When a new bank-managed field lands, add it here too —
 * the schema's `additionalProperties: false` at the root will otherwise
 * reject the skill at exec re-validation, breaking exec for that field's
 * users. There is a regression test in tests/exec.test.ts that exercises
 * this for `command_source` (the v2.1.0 pack-distributed CustomCommand
 * source); follow that pattern when adding new fields.
 */
const extractFrontmatter = (skill: IndexedSkill): SkillFrontmatter => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    identity, provenance, embedding, embedding_model,
    inserted_at, updated_at, deprecated, removed, usage_count, avg_rating,
    command_source,
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
 * Run the substituted `command_template` via a SANDBOXED just-bash
 * runtime per SPEC §4.4. Sandbox primitives applied:
 *
 * - **Filesystem**: a fresh per-skill scratch directory (exposed via
 *   `$AGENT_SCRATCH`). Skill cannot read/write outside that root.
 * - **Network**: restricted to the skill's declared `network` allowlist.
 *   Empty/missing `network` means no HTTP access at all.
 * - **Env vars**: scoped to `required_env ∪ optional_env`. Other host
 *   env is invisible to the skill (preserves SPEC §8 P1 — credentials
 *   the skill didn't declare don't leak).
 * - **Process spawning**: just-bash by design only allows registered
 *   CustomCommands and built-ins; no `/bin/sh` fallback (SPEC §4.4
 *   "Prevent process spawning beyond required_commands").
 *
 * Scratch dir is cleaned up after the exec finishes, regardless of
 * whether the command succeeded or timed out.
 */
const runBash = async (
  command: string,
  timeoutSec: number,
  envWhitelist: string[],
  network: string[],
  extraCommands: CustomCommand[],
): Promise<{ exit_code: number; stdout: string; stderr: string; elapsed_ms: number; timed_out: boolean }> => {
  const { bash, scratchDir } = createSandboxedExec({ network, extraCommands });
  try {
    const env: Record<string, string> = { AGENT_SCRATCH: scratchDir };
    for (const name of envWhitelist) {
      const value = process.env[name];
      if (typeof value === "string") env[name] = value;
    }
    return await runBashCommand(bash, command, timeoutSec, { env });
  } finally {
    cleanupScratch(scratchDir);
  }
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

  // 5. Execute via the sandboxed just-bash per SPEC §4.4. Env, network,
  //    and FS access are scoped to what the skill declared in its
  //    frontmatter; nothing else reaches the running command.
  //
  //    If the pack shipped a CustomCommand alongside the SKILL.md
  //    (v2.1.0+ convention), load it now and register on the bash
  //    instance before running command_template.
  const timeoutSec = opts.timeoutSec ?? 60;
  const envWhitelist = [
    ...(frontmatter.required_env ?? []),
    ...(frontmatter.optional_env ?? []),
  ];
  const network = frontmatter.network ?? [];
  const extraCommands: CustomCommand[] = [];
  if (typeof skill.command_source === "string" && skill.command_source.length > 0) {
    const loaded = await loadCustomCommandFromSource(skill.command_source);
    if (loaded !== null) extraCommands.push(loaded);
  }
  const result = await runBash(resolved.command, timeoutSec, envWhitelist, network, extraCommands);

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
