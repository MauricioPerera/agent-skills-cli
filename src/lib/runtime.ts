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

import {
  Bash,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  defineCommand,
  type Command,
  type CommandContext,
  type CustomCommand,
  type ExecOptions,
  type ExecResult,
  type IFileSystem,
  type NetworkConfig,
} from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
  /**
   * Filesystem allowlist per SPEC §2.11 (schema 0.2+). Each entry is
   * a host-absolute directory path; the sandbox grants read-only
   * access to those paths in addition to `$AGENT_SCRATCH`. Writes
   * still go exclusively to scratch — this is a read allowlist.
   * When empty/missing, scratch is the only readable path (v0.1
   * default, preserved).
   */
  filesystem?: string[];
  /**
   * Pack-distributed CustomCommands to register alongside the data
   * plugin. Loaded by the bank from `command.js` files shipped in the
   * skill's pack directory (v2.1.0+).
   */
  extraCommands?: CustomCommand[];
}

/**
 * The API surface a pack-distributed `command.js` receives when the bank
 * loads it. Stable contract per v2.1.0+; new fields can be added in
 * minor releases without breaking existing packs.
 */
export interface PackCommandApi {
  /** Same as just-bash's defineCommand. The pack uses this to build its Command. */
  defineCommand: (
    name: string,
    execute: (args: string[], ctx: CommandContext) => Promise<ExecResult>,
  ) => Command;
}

/**
 * Dynamically import a pack-distributed CustomCommand from raw JS source.
 *
 * Pack convention (v2.1.0+): each skill directory MAY contain a
 * `command.js` ESM module whose default export is a **factory function**
 * `(api: PackCommandApi) => Command`. The factory pattern is used (vs
 * exporting the Command directly) so the pack does not need to resolve
 * the bare specifier `"just-bash"` at runtime — the bank injects
 * `defineCommand` instead.
 *
 * Example pack-side `command.js`:
 *
 *   export default ({ defineCommand }) =>
 *     defineCommand("gh-pr-summary", async (args, ctx) => {
 *       // ... do work, return ExecResult
 *     });
 *
 * The bank fetches this file on sync and stores it on the indexed skill.
 * At exec time the source is `import()`ed via a `data:` URL, the factory
 * is called with the bank's `PackCommandApi`, and the resulting Command
 * is registered on the sandboxed Bash instance before running
 * `command_template`.
 *
 * Returns the Command, or `null` on any import / shape failure — a null
 * result means the skill falls back to just-bash defaults (built-ins +
 * just-bash-data); commands referenced in `command_template` that aren't
 * available will fail with "command not found" at exec.
 *
 * The optional `onError` callback receives a structured `reason` plus the
 * underlying `error` (if any) so callers can surface a diagnosable message
 * to the operator. Without it, malformed packs fail silently — the only
 * visible symptom is "command not found" from the runtime, which is the
 * single biggest source of pack-author confusion. Exec passes a callback
 * that emits one `console.warn` keyed by the skill identity.
 */

/**
 * Why the load failed. Stable strings — callers may switch on these.
 *
 *   - "import-failed":  the data:URL import threw (most often an ESM
 *                       parse error in the pack's command.js, or a
 *                       runtime ReferenceError if the pack tried to
 *                       resolve a bare specifier like `import "node:fs"`).
 *   - "no-default":     the module loaded but didn't `export default` a
 *                       function. The pack convention requires a factory.
 *   - "factory-threw":  `default(api)` threw. The factory should be pure
 *                       data-construction work; if it does I/O, a network
 *                       blip can land here.
 *   - "factory-empty":  the factory returned `null`/`undefined`.
 *   - "shape-invalid":  the factory returned a value that is not a
 *                       Command (missing `name: string` or
 *                       `execute: function`).
 */
export type LoadFailureReason =
  | "import-failed"
  | "no-default"
  | "factory-threw"
  | "factory-empty"
  | "shape-invalid";

export interface LoadCommandOptions {
  /**
   * Called once when the load fails (returns `null`). Never called on the
   * happy path. Implementations should be cheap — exec invokes this on the
   * critical path. Throwing from `onError` is treated as a programming
   * error and propagates up; do not throw.
   */
  onError?: (reason: LoadFailureReason, error: unknown) => void;
}

export const loadCustomCommandFromSource = async (
  source: string,
  opts: LoadCommandOptions = {},
): Promise<Command | null> => {
  let mod: { default?: unknown };
  try {
    const dataUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
    mod = (await import(dataUrl)) as { default?: unknown };
  } catch (err) {
    opts.onError?.("import-failed", err);
    return null;
  }

  if (typeof mod.default !== "function") {
    opts.onError?.("no-default", null);
    return null;
  }

  const factory = mod.default as (api: PackCommandApi) => unknown;
  let cmd: unknown;
  try {
    cmd = factory({ defineCommand });
  } catch (err) {
    opts.onError?.("factory-threw", err);
    return null;
  }

  if (cmd === null || cmd === undefined) {
    opts.onError?.("factory-empty", null);
    return null;
  }
  const candidate = cmd as { name?: unknown; execute?: unknown };
  if (typeof candidate.name !== "string" || typeof candidate.execute !== "function") {
    opts.onError?.("shape-invalid", null);
    return null;
  }
  return cmd as Command;
};

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
/**
 * Translate an agent-skills `network` allowlist into a just-bash NetworkConfig.
 *
 * The agent-skills SPEC §2.10 / §4.4 lets skills declare `network` as a list
 * of origins. just-bash, however, has stricter semantics:
 *
 *   1. Each entry is parsed as a fully-qualified URL with literal origin.
 *      Wildcard syntax like `https://*` parses (origin becomes `https://*`)
 *      but never matches any real URL.
 *   2. `allowedMethods` defaults to `["GET", "HEAD"]`. POST/PUT/DELETE/PATCH
 *      are blocked by default even when the URL is allowed.
 *
 * The pack ecosystem in practice ships skills that declare:
 *   - `network: ["https://*", "http://*"]` for "any URL the user provides"
 *     (e.g., http-get, http-post-json — generic HTTP fetchers).
 *   - `network: ["https://api.github.com/"]` for skills targeting one origin.
 *
 * The first form fails silently (matches nothing) without this translation.
 * Skill authors writing `https://*` clearly intend "any HTTPS"; honouring
 * that intent requires `dangerouslyAllowFullInternetAccess: true`.
 *
 * Translation rules:
 *   - If any entry is `https://*`, `http://*`, or just `*` →
 *     dangerouslyAllowFullInternetAccess: true + all-methods, AND keep
 *     non-wildcard entries as `allowedUrlPrefixes` so they're documented.
 *   - Otherwise: pass entries through unchanged; the skill expects strict
 *     origin policy (no methods extension — caller must opt in via SPEC if
 *     they need POST against a specific origin).
 *
 * Returns `undefined` when no network access is granted (empty/missing).
 */
export const buildNetworkConfig = (network?: string[]): NetworkConfig | undefined => {
  if (network === undefined || network.length === 0) return undefined;

  const isWildcard = (entry: string): boolean =>
    entry === "*" || entry === "https://*" || entry === "http://*" ||
    entry === "https://*/" || entry === "http://*/";

  const wildcards = network.filter(isWildcard);
  const specific = network.filter((e) => !isWildcard(e));

  if (wildcards.length > 0) {
    // Skill explicitly opted into "any URL". Mirror that into just-bash's
    // dangerous-allow flag and unlock all common HTTP methods (otherwise
    // POST-shaped skills would still fail).
    const cfg: NetworkConfig = {
      dangerouslyAllowFullInternetAccess: true,
      allowedMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    };
    if (specific.length > 0) {
      cfg.allowedUrlPrefixes = specific;
    }
    return cfg;
  }

  // Strict-origin mode. just-bash's default (GET + HEAD only) applies; if
  // a skill needs POST against a specific origin, the SPEC needs an
  // `allowed_methods` field (not yet defined). For now, callers using
  // strict origins are GET-only.
  return { allowedUrlPrefixes: specific };
};

/**
 * Convert a host path to a POSIX-style virtual mount point that
 * `MountableFs` accepts (it requires absolute paths starting with '/').
 *
 * On POSIX hosts (Linux / macOS) any absolute host path is already
 * valid, so the function returns it unchanged.
 *
 * On Windows host paths look like `C:\Users\foo` — those aren't
 * accepted by MountableFs. We translate them to POSIX-style:
 * `C:\Users\foo` → `/c/Users/foo`. The drive letter is lower-cased
 * for visual stability and the backslashes are flipped.
 *
 * Skill authors writing portable SKILL.md MUST use POSIX paths in
 * `filesystem` — that's what SPEC §2.11 says ("host-absolute directory
 * path"). This helper exists so tests, dev tooling, and Windows-only
 * banks aren't blocked.
 */
const toVirtualMountPoint = (hostPath: string): string => {
  // Already POSIX-style absolute → use as-is.
  if (hostPath.startsWith("/")) return hostPath;
  // Windows-style absolute (e.g., "C:\\Users\\foo" or "C:/Users/foo").
  const winMatch = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (winMatch !== null) {
    const drive = winMatch[1]!.toLowerCase();
    const rest = winMatch[2]!.replace(/\\/g, "/");
    return rest.length === 0 ? `/${drive}` : `/${drive}/${rest}`;
  }
  // Fallback: prepend '/' and hope.
  return "/" + hostPath.replace(/\\/g, "/");
};

/**
 * Build the IFileSystem for a sandboxed exec.
 *
 * Default (no `filesystem` allowlist): the bash sees only the per-skill
 * scratch dir as `/`, just like the v0.1 sandbox (writes ok, no host
 * paths reachable). This preserves the SPEC §4.4 "scratch only" rule
 * for skills that don't use the v0.2 `filesystem` field.
 *
 * With `filesystem: [paths…]`: build a `MountableFs` whose base is the
 * scratch dir (writable) and which mounts each declared host path as
 * an `OverlayFs(readOnly: true)` at the same virtual path. Reads under
 * a mount point go to the host filesystem (read-only); writes anywhere
 * outside scratch raise an error from the OverlayFs read-only guard.
 *
 * Implements SPEC §2.11 + the read/write split in §4.4.
 */
export const buildSandboxFs = (
  scratchDir: string,
  filesystem?: string[],
): IFileSystem => {
  const baseScratch = new ReadWriteFs({ root: scratchDir });

  if (filesystem === undefined || filesystem.length === 0) {
    return baseScratch;
  }

  const fs = new MountableFs({ base: baseScratch });
  for (const hostPath of filesystem) {
    // Skip entries that don't exist on this host. Skills declaring
    // `filesystem: ["/etc"]` for portability shouldn't crash the bank
    // on hosts where that path simply isn't present (e.g., Windows).
    // The skill will see a smaller-than-declared mount set; commands
    // referring to absent paths fail cleanly with ENOENT at exec time.
    let exists = false;
    try {
      exists = existsSync(hostPath) && statSync(hostPath).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      // Best-effort signal to the operator without polluting test output.
      // process.stderr is safe — never the LLM context.
      process.stderr.write(
        `[agent-skills] filesystem allowlist entry skipped (not a directory on this host): ${hostPath}\n`,
      );
      continue;
    }

    // Per SPEC §2.11, banks MAY canonicalize entries. We trust the
    // bank's already-validated input here (validateSkill enforces the
    // pattern `^/[^\\0]*$` in the JSON Schema). Windows host paths get
    // translated to POSIX-style virtual mount points (see helper).
    const mountPoint = toVirtualMountPoint(hostPath);
    // MountableFs strips its mount-point prefix before forwarding to the
    // inner fs (verified empirically on just-bash 2.x). The inner
    // OverlayFs therefore sees paths starting at "/" — set its own
    // mountPoint to "/" so its root maps to the request's '/'. Without
    // this, OverlayFs defaults its mountPoint to "/home/user/project"
    // and presents the host content under that virtual subdir, which
    // doesn't compose with MountableFs's prefix stripping.
    fs.mount(mountPoint, new OverlayFs({
      root: hostPath,
      mountPoint: "/",
      readOnly: true,
    }));
  }
  return fs;
};

export const createSandboxedExec = (
  opts: SandboxedExecOptions = {},
): { bash: Bash; scratchDir: string } => {
  const scratchDir = mkdtempSync(join(tmpdir(), "agent-skills-scratch-"));
  const network = buildNetworkConfig(opts.network);
  const dataCmds = createDataPlugin({
    rootDir: opts.rootDir ?? "/data",
    encryptionKey: opts.encryptionKey,
    authSecret: opts.authSecret,
    salt: opts.salt,
  });
  const customCommands: CustomCommand[] = opts.extraCommands !== undefined
    ? [...dataCmds, ...opts.extraCommands]
    : dataCmds;
  const bash = new Bash({
    fs: buildSandboxFs(scratchDir, opts.filesystem),
    customCommands,
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
 * Pull the equality fields out of a filter object: keys whose value is a
 * scalar (string / number / boolean / null) and not a Mongo operator key
 * (`$xxx`). Used to seed the doc inserted by an upsert on a missing match.
 *
 * Operator-bearing filters (`$or`, `$gt`, …) intentionally don't contribute
 * — there's no sensible scalar to insert from those. The bank's usage is
 * always plain `{ _id: id }`, which falls cleanly into the scalar branch.
 */
const extractFilterScalars = (filter: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith("$")) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      out[k] = v;
    }
  }
  return out;
};

/**
 * Update documents matching `filter` with `update` (MongoDB-style ops).
 * Returns the count of modified documents.
 *
 * `upsert: true` semantics (v2.1.1+):
 *   When no document matches `filter`, insert a new one synthesized from
 *   the filter's scalar equality clauses merged with `update.$set` (set
 *   wins on key conflict). Returns `{ modified: 0, upserted: <_id> }` if
 *   the insert produced an `_id`, else `{ modified: 0 }`.
 *
 *   We do this in-process via `count → insert | update` rather than
 *   passing `--upsert` to just-bash-data, because that flag is parsed
 *   but silently no-op'd by the plugin (verified empirically with v1.1).
 *   Relying on it would mean upsert calls succeed-with-zero-changes
 *   instead of inserting — a footgun the bank ran into during the
 *   v2.0 storage migration. The wrapper hides the issue.
 *
 *   Caveats:
 *     - `filter` must use scalar equality clauses for any field you want
 *       seeded into the inserted doc. Operator keys (`$or`, `$gt`, …)
 *       are ignored for seeding (matched-only).
 *     - With `upsert + many`: not supported; throws. The MongoDB rule
 *       (one upsert insert max regardless of `many`) is non-trivial to
 *       reproduce here and the bank has no need for it.
 */
export const dbUpdate = async (
  bash: Bash,
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  opts: { many?: boolean; upsert?: boolean } = {},
): Promise<{ modified: number; upserted?: string }> => {
  if (opts.upsert === true && opts.many === true) {
    throw new CliError(
      EXIT.RUNTIME,
      `dbUpdate: { upsert: true, many: true } is not supported`,
    );
  }

  // Upsert path: probe with count, branch insert vs update. Wrapped here
  // so external callers don't need to repeat the pattern (and so the
  // ignored `--upsert` flag can never bite anyone again).
  if (opts.upsert === true) {
    const matched = await dbCount(bash, collection, filter);
    if (matched === 0) {
      const setFields = update["$set"];
      const seed = extractFilterScalars(filter);
      const setObj =
        typeof setFields === "object" && setFields !== null && !Array.isArray(setFields)
          ? (setFields as Record<string, unknown>)
          : {};
      const doc = { ...seed, ...setObj };
      try {
        const inserted = await dbInsert(bash, collection, doc);
        const insertedId =
          typeof (inserted as { _id?: unknown })._id === "string"
            ? ((inserted as { _id: string })._id)
            : undefined;
        return insertedId !== undefined
          ? { modified: 0, upserted: insertedId }
          : { modified: 0 };
      } catch (err) {
        // Re-frame so callers see "<collection> upsert insert failed: …"
        // instead of the raw db helper message.
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(EXIT.RUNTIME, `${collection} upsert insert failed: ${msg}`);
      }
    }
    // matched > 0 — fall through to the regular update path.
  }

  const args = [collection, "update", JSON.stringify(filter), JSON.stringify(update)];
  if (opts.many === true) args.push("--many");
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
    // Same sentinel as runDb. just-bash-data emits identical
    // "exit 3 + stderr 'not found: <coll>'" framing for both `db` and
    // `vec` when the underlying collection is absent, so a single
    // detection rule + sentinel covers both. Callers (vecStore,
    // vecSearch, vecRemove) translate it to their own semantics.
    const missing = isCollectionNotFound(result.exitCode, result.stderr);
    if (missing !== null) {
      throw new CollectionNotFound(missing);
    }
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
    if (err instanceof CollectionNotFound) {
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
    if (err instanceof CollectionNotFound) return [];
    throw err;
  }
};

/**
 * Remove a vector by id. Returns true if removed, false if absent.
 *
 * Two flavors of "absent" are folded into `false`:
 *   - the collection itself doesn't exist (CollectionNotFound from runVec)
 *   - the collection exists but doesn't contain the id (just-bash-data
 *     emits a non-3 exit with a "not found:" message that doesn't match
 *     the collection-level framing — we still want false here, hence the
 *     fallback regex on CliError messages).
 *
 * Anything else propagates.
 */
export const vecRemove = async (
  bash: Bash,
  collection: string,
  id: string,
): Promise<boolean> => {
  try {
    await runVec(bash, ["remove", collection, id]);
    return true;
  } catch (err) {
    if (err instanceof CollectionNotFound) return false;
    if (err instanceof CliError && /not found:/.test(err.message)) return false;
    throw err;
  }
};
