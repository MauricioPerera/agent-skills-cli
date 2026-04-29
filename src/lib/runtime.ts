// Skill execution runtime — built on `just-bash` per IMPLEMENTATION.md.
//
// The agent-skills spec's reference runtime is `just-bash` (an AST-based
// bash interpreter that runs in-process, see DESIGN.md §357 + IMPLEMENTATION.md
// "exec-skill.sh"). `just-bash-data` registers the `db` and `vec` commands
// the spec uses for storage / retrieval inside the bank's bash environment.
//
// This module exposes:
//   - createBashRuntime() — ephemeral Bash for one-off skill execution.
//     In-memory FS; data plugin loaded but its persistence is per-call.
//   - createBankBash(bankDir) — long-lived Bash backed by ReadWriteFs at
//     a host directory. db / vec collections persist across invocations,
//     matching IMPLEMENTATION.md's storage model.
//   - dbFind / dbInsert / dbUpdate / dbRemove — typed helpers for issuing
//     `db <coll> <op>` commands and parsing the JSON result.

import { Bash, ReadWriteFs, type ExecOptions } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { mkdirSync } from "node:fs";

import { CliError, EXIT } from "./errors.js";

export interface BashRuntimeOptions {
  /**
   * Root directory inside just-bash's virtual filesystem where
   * `just-bash-data` stores its `db` collections and `vec` indexes.
   * Defaults to `/data`, matching IMPLEMENTATION.md examples.
   */
  rootDir?: string;
  encryptionKey?: string;
  authSecret?: string;
  salt?: string;
}

export interface BankBashOptions extends BashRuntimeOptions {
  /**
   * Host directory backing the just-bash filesystem. `db` collections
   * and `vec` indexes live under `<bankDir>/data/` on the host.
   */
  bankDir: string;
}

/**
 * Ephemeral runtime for one-shot skill execution. In-memory FS; nothing
 * persists across calls. Use for `agent-skills exec` of a stateless skill.
 */
export const createBashRuntime = (opts: BashRuntimeOptions = {}): Bash =>
  new Bash({
    customCommands: createDataPlugin({
      rootDir: opts.rootDir ?? "/data",
      encryptionKey: opts.encryptionKey,
      authSecret: opts.authSecret,
      salt: opts.salt,
    }),
  });

/**
 * Bank-scoped runtime backed by a real host directory. Two Bash
 * instances created with the same `bankDir` see the same `db` /
 * `vec` state — the persistence model the spec assumes for the
 * sync → query → exec lifecycle.
 */
export const createBankBash = (opts: BankBashOptions): Bash => {
  mkdirSync(opts.bankDir, { recursive: true });
  return new Bash({
    fs: new ReadWriteFs({ root: opts.bankDir }),
    customCommands: createDataPlugin({
      rootDir: opts.rootDir ?? "/data",
      encryptionKey: opts.encryptionKey,
      authSecret: opts.authSecret,
      salt: opts.salt,
    }),
  });
};

/**
 * Run a bash command via the configured just-bash runtime. Honors timeout
 * via the cooperative `AbortSignal` documented in just-bash's exec API
 * (the interpreter checks the signal at statement boundaries).
 */
export const runBashCommand = async (
  bash: Bash,
  command: string,
  timeoutSec: number,
  extraOptions: Pick<ExecOptions, "env" | "replaceEnv" | "cwd"> = {},
): Promise<{ exit_code: number; stdout: string; stderr: string; elapsed_ms: number; timed_out: boolean }> => {
  const start = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
  try {
    const result = await bash.exec(command, {
      ...extraOptions,
      signal: ac.signal,
    });
    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsed_ms: Date.now() - start,
      timed_out: ac.signal.aborted,
    };
  } catch (err) {
    const aborted = ac.signal.aborted;
    return {
      exit_code: aborted ? 124 : 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
      timed_out: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ─── db helpers (IMPLEMENTATION.md schema mapping) ────────────────────
//
// The data plugin shells just-bash-data's `db <coll> <op> <args>` interface.
// These helpers JSON-encode arguments, run via bash.exec, and parse the
// JSON response. Errors from the underlying command are surfaced as
// CliError (RUNTIME). Single-quoting follows the same policy as the
// substitution rules in lib/substitute.ts so embedded single quotes in
// JSON values don't break the shell parse.

/** Single-quote a string for safe inclusion in a bash command. */
const sq = (raw: string): string => `'${raw.replace(/'/g, "'\\''")}'`;

/**
 * Sentinel raised internally when just-bash-data returns "not found: <coll>"
 * (exit code 3 + that exact stderr). For read-only operations (`find`,
 * `count`) the absence of a collection is semantically equivalent to "no
 * documents", so the dbFind / dbCount wrappers translate this to empty /
 * zero. For mutating operations (`insert`, `update`, `remove`) the caller
 * sees the failure normally.
 */
class CollectionNotFound extends Error {
  constructor(public readonly collection: string) {
    super(`collection not found: ${collection}`);
  }
}

const isCollectionNotFound = (
  exitCode: number,
  stderr: string,
): string | null => {
  if (exitCode !== 3) return null;
  const m = stderr.trim().match(/^not found:\s*(\S+)/);
  return m ? m[1]! : null;
};

const runDb = async (
  bash: Bash,
  args: string[],
): Promise<string> => {
  const cmd = ["db", ...args.map(sq)].join(" ");
  const result = await bash.exec(cmd);
  if (result.exitCode !== 0) {
    const missing = isCollectionNotFound(result.exitCode, result.stderr);
    if (missing !== null) {
      throw new CollectionNotFound(missing);
    }
    throw new CliError(
      EXIT.RUNTIME,
      `db command failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
};

const parseJson = <T>(raw: string, context: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `db ${context}: failed to parse JSON response (${msg}): ${raw.slice(0, 200)}`);
  }
};

/** Insert a document. Returns the inserted doc (with `_id` filled if absent). */
export const dbInsert = async <T extends Record<string, unknown>>(
  bash: Bash,
  collection: string,
  doc: T,
): Promise<T> => {
  const out = await runDb(bash, [collection, "insert", JSON.stringify(doc)]);
  return parseJson<T>(out, `${collection} insert`);
};

/**
 * Find documents matching `filter`. Empty filter = all docs.
 * If the collection doesn't exist yet, returns `[]` (a freshly-created
 * bank has no documents and no collections; both are "no results").
 */
export const dbFind = async <T = Record<string, unknown>>(
  bash: Bash,
  collection: string,
  filter: Record<string, unknown> = {},
  opts: { sort?: string; limit?: number; skip?: number } = {},
): Promise<T[]> => {
  const args = [collection, "find", JSON.stringify(filter)];
  if (opts.sort !== undefined) args.push("--sort", opts.sort);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.skip !== undefined) args.push("--skip", String(opts.skip));
  try {
    const out = await runDb(bash, args);
    return parseJson<T[]>(out, `${collection} find`);
  } catch (err) {
    if (err instanceof CollectionNotFound) return [];
    throw err;
  }
};

/**
 * Update documents matching `filter` with `update` (MongoDB-style ops).
 * Returns the count of modified documents.
 */
export const dbUpdate = async (
  bash: Bash,
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  opts: { many?: boolean; upsert?: boolean } = {},
): Promise<{ modified: number; upserted?: string }> => {
  const args = [collection, "update", JSON.stringify(filter), JSON.stringify(update)];
  if (opts.many === true) args.push("--many");
  if (opts.upsert === true) args.push("--upsert");
  const out = await runDb(bash, args);
  return parseJson<{ modified: number; upserted?: string }>(out, `${collection} update`);
};

/** Remove documents matching `filter`. Returns count removed. */
export const dbRemove = async (
  bash: Bash,
  collection: string,
  filter: Record<string, unknown>,
  opts: { many?: boolean } = {},
): Promise<{ removed: number }> => {
  const args = [collection, "remove", JSON.stringify(filter)];
  if (opts.many === true) args.push("--many");
  const out = await runDb(bash, args);
  return parseJson<{ removed: number }>(out, `${collection} remove`);
};

/**
 * Count documents matching `filter`. Returns 0 if the collection doesn't
 * exist yet — the absence of a collection is semantically equivalent
 * to "no documents".
 */
export const dbCount = async (
  bash: Bash,
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<number> => {
  try {
    const out = await runDb(bash, [collection, "count", JSON.stringify(filter)]);
    const parsed = parseJson<{ count: number }>(out, `${collection} count`);
    return parsed.count;
  } catch (err) {
    if (err instanceof CollectionNotFound) return 0;
    throw err;
  }
};
