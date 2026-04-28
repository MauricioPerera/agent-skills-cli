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

import { spawn } from "node:child_process";
import type { AuditEntry, FileBank, IndexedSkill } from "../lib/bank.js";
import type { SkillFrontmatter } from "../types.js";
import { CliError, EXIT } from "../lib/errors.js";
import { resolveCommand } from "../lib/substitute.js";
import { validateSkill } from "../lib/validate.js";

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
 * Spawn `bash -c <command>` and capture I/O + exit code. Enforces a hard
 * timeout via a 3-stage kill ladder:
 *   1. SIGTERM at timeoutSec.
 *   2. SIGKILL at timeoutSec + 2s grace.
 *   3. Forced promise resolution at timeoutSec + 4s, regardless of whether
 *      `proc.on('close')` fires. This guards against platforms (notably
 *      Windows msys / Git Bash) where signals don't always propagate through
 *      to grandchildren of bash and the proc would otherwise hang.
 */
const runBash = async (
  command: string,
  timeoutSec: number,
): Promise<{ exit_code: number; stdout: string; stderr: string; elapsed_ms: number; timed_out: boolean }> => {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const settle = (result: { exit_code: number; stdout: string; stderr: string; elapsed_ms: number; timed_out: boolean }): void => {
      if (resolved) return;
      resolved = true;
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };

    const proc = spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      // Inherit env so $STRIPE_KEY etc. are visible to the shell at exec time.
      env: process.env,
    });

    // Soft timeout → SIGTERM, then 2s grace → SIGKILL.
    const softTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }, 2000);
      // Hard timeout: forcibly resolve even if `close` never fires
      // (Windows msys bash may not propagate signals to grandchildren).
      forceTimer = setTimeout(() => {
        settle({
          exit_code: 124, // canonical 'timeout' exit code
          stdout,
          stderr,
          elapsed_ms: Date.now() - start,
          timed_out: true,
        });
      }, 4000);
    }, timeoutSec * 1000);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    proc.on("close", (code, signal) => {
      clearTimeout(softTimer);
      settle({
        exit_code: code !== null ? code : (signal !== null ? 128 + 15 : 1),
        stdout,
        stderr,
        elapsed_ms: Date.now() - start,
        timed_out: timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(softTimer);
      settle({
        exit_code: 1,
        stdout: "",
        stderr: `spawn error: ${err.message}\n`,
        elapsed_ms: Date.now() - start,
        timed_out: false,
      });
    });
  });
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

  // 5. Execute via bash with a timeout
  const timeoutSec = opts.timeoutSec ?? 60;
  const result = await runBash(resolved.command, timeoutSec);

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
