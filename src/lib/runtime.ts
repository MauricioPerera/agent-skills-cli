// Skill execution runtime — built on `just-bash` per IMPLEMENTATION.md.
//
// The agent-skills spec's reference runtime is `just-bash` (an AST-based
// bash interpreter that runs in-process, see DESIGN.md §357 + IMPLEMENTATION.md
// "exec-skill.sh"). `just-bash-data` registers the `db` and `vec` commands
// the spec uses for storage / retrieval inside the bank's bash environment.
//
// This module exposes the single-instance `Bash` factory. Callers
// (`runExec`, eventually `runSync` / `runQuery`) take a `Bash` and issue
// commands against it instead of spawning subprocesses to the host shell.

import { Bash, type ExecOptions } from "just-bash";
import { createDataPlugin } from "just-bash-data";

export interface BashRuntimeOptions {
  /**
   * Root directory inside just-bash's virtual filesystem where
   * `just-bash-data` stores its `db` collections and `vec` indexes.
   * Defaults to `/data`, matching IMPLEMENTATION.md examples.
   */
  rootDir?: string;
  /**
   * Optional encryption key for `db` / `vec` at-rest encryption (AES-256-GCM).
   * When set, every collection write is encrypted; reads decrypt transparently.
   */
  encryptionKey?: string;
  /**
   * Optional auth secret for the `db auth` JWT subcommands.
   */
  authSecret?: string;
  /**
   * Optional PBKDF2 salt — required for multi-tenant deployments where
   * each tenant should derive distinct keys from a shared password.
   */
  salt?: string;
}

/** Returns a Bash instance with the just-bash-data plugin pre-loaded. */
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
 * Run a bash command via the configured just-bash runtime. Honors timeout
 * via the cooperative `AbortSignal` documented in just-bash's exec API
 * (the interpreter checks the signal at statement boundaries).
 *
 * Returns the raw `{ stdout, stderr, exitCode }`. Caller layers timeout +
 * audit + redaction on top.
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
    // Aborted execs can throw rather than resolve in some interpreter paths.
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
