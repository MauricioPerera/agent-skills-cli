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

import { Bash, ReadWriteFs, type ExecOptions, type NetworkConfig } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export interface SandboxedExecOptions extends BashRuntimeOptions {
  /**
   * Network allowlist per SPEC §2.10. Each entry is a full origin
   * (scheme + host) optionally followed by a path prefix. When empty,
   * no network access is permitted.
   */
  network?: string[];
}

/**
 * Sandboxed runtime for executing one skill, per SPEC §4.4 sandbox mode.
 *
 * - Filesystem restricted to a fresh per-skill scratch dir (exposed as
 *   `$AGENT_SCRATCH` to the skill).
 * - Network restricted to the skill's declared `network` allowlist.
 *   (Empty network → no HTTP access.)
 * - Process spawning bounded by just-bash's "no `/bin/sh` reachable"
 *   property (only registered CustomCommands are callable).
 *
 * Returns the Bash instance plus the scratch path. Caller is responsible
 * for cleaning up the scratch dir after the exec completes (this gives
 * the bank a chance to inspect outputs before deletion).
 */
export const createSandboxedExec = (
  opts: SandboxedExecOptions = {},
): { bash: Bash; scratchDir: string } => {
  const scratchDir = mkdtempSync(join(tmpdir(), "agent-skills-scratch-"));
  const network: NetworkConfig | undefined =
    opts.network !== undefined && opts.network.length > 0
      ? { allowedUrlPrefixes: opts.network }
      : undefined;
  const bash = new Bash({
    fs: new ReadWriteFs({ root: scratchDir }),
    customCommands: createDataPlugin({
      rootDir: opts.rootDir ?? "/data",
      encryptionKey: opts.encryptionKey,
      authSecret: opts.authSecret,
      salt: opts.salt,
    }),
    ...(network !== undefined ? { network } : {}),
  });
  return { bash, scratchDir };
};

/** Recursively remove a scratch dir created by createSandboxedExec. */
export const cleanupScratch = (scratchDir: string): void => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

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

// ─── vec helpers ──────────────────────────────────────────────────────
//
// just-bash-data's `vec` command provides cosine-similarity vector search
// (SPEC §4.3 / IMPLEMENTATION.md "vec store" + "vec search"). The plugin's
// vec collections are created with an explicit `--dim` and do NOT
// auto-create on first store. The bank must bootstrap the collection
// once the embedding dim is known.

const runVec = async (
  bash: Bash,
  args: string[],
): Promise<string> => {
  const cmd = ["vec", ...args.map(sq)].join(" ");
  const result = await bash.exec(cmd);
  if (result.exitCode !== 0) {
    throw new CliError(
      EXIT.RUNTIME,
      `vec command failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
};

/**
 * Create a vec collection. Idempotent on dim match: a second `vec create`
 * with the same dim is silently OK; with a different dim it surfaces
 * the underlying validation error.
 */
export const vecCreate = async (
  bash: Bash,
  collection: string,
  dim: number,
): Promise<void> => {
  const cmd = `vec create ${sq(collection)} --dim ${String(dim)}`;
  const result = await bash.exec(cmd);
  if (result.exitCode === 0) return;
  // Exit 5 + stderr "collection exists" is the idempotent-create case.
  if (result.exitCode === 5 && /collection exists/.test(result.stderr)) return;
  throw new CliError(
    EXIT.RUNTIME,
    `vec create failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
  );
};

// Note: vec command convention is `vec <subcommand> <collection> <args>`,
// the inverse of db's `db <collection> <subcommand> <args>`. The helpers
// below reflect that.

/**
 * Store a vector for an id. Replace semantics — same id overwrites.
 * If the collection doesn't exist yet, it's auto-created with the dim
 * of the first stored vector (per SPEC §4.2 / §4.3 the bank uses one
 * embedding model so all vectors share a dim, making this safe).
 */
export const vecStore = async (
  bash: Bash,
  collection: string,
  id: string,
  vector: number[],
): Promise<void> => {
  try {
    await runVec(bash, ["store", collection, id, JSON.stringify(vector)]);
  } catch (err) {
    if (err instanceof CliError && /not found:/.test(err.message)) {
      await vecCreate(bash, collection, vector.length);
      await runVec(bash, ["store", collection, id, JSON.stringify(vector)]);
      return;
    }
    throw err;
  }
};

/** Cosine search for top-k matches against a query vector. */
export const vecSearch = async (
  bash: Bash,
  collection: string,
  queryVector: number[],
  k: number,
): Promise<Array<{ id: string; score: number }>> => {
  try {
    const out = await runVec(bash, [
      "search",
      collection,
      JSON.stringify(queryVector),
      "--k",
      String(k),
    ]);
    const parsed = parseJson<Array<{ id: string; score: number; metadata?: unknown }>>(
      out,
      `${collection} search`,
    );
    return parsed.map(({ id, score }) => ({ id, score }));
  } catch (err) {
    if (err instanceof CliError && /not found:/.test(err.message)) return [];
    throw err;
  }
};

/** Remove a vector by id. Returns true if removed, false if absent. */
export const vecRemove = async (
  bash: Bash,
  collection: string,
  id: string,
): Promise<boolean> => {
  try {
    await runVec(bash, ["remove", collection, id]);
    return true;
  } catch (err) {
    if (err instanceof CliError && /not found:/.test(err.message)) return false;
    throw err;
  }
};
