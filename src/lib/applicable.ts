// applicable_when filter at query time.
//
// SPEC §2.7 lets skills declare:
//
//   applicable_when:
//     os: ["linux", "macos"]
//     arch: ["x86_64", "arm64"]
//     shell_commands_present: ["jq", "curl"]
//     env_present: ["STRIPE_KEY"]
//     env_absent: ["DRY_RUN"]
//
// Banks operating at retrieval time (per SPEC §4.3) MAY filter results by
// these constraints against the host environment.
//
// This module evaluates a skill's applicable_when against:
//   - The current process env (process.env)
//   - The host OS / arch (platform detection)
//   - shell_commands_present check (we DO NOT actually call `which` —
//     too expensive at query time. Instead, banks SHOULD optionally
//     pre-compute available commands; this module accepts that as a
//     parameter. If unset, command checks pass through.)

import { execSync } from "node:child_process";
import { platform, arch } from "node:os";
import type { ApplicableWhen } from "../types.js";

export interface HostContext {
  /** Lowercase OS name. e.g. "linux", "macos", "windows". */
  os: string;
  /** Lowercase arch. e.g. "x86_64", "arm64". */
  arch: string;
  /** Env vars present. Default: process.env keys. */
  envKeys: Set<string>;
  /** Optional: set of shell commands known to be on PATH. If undefined, command checks are skipped. */
  shellCommandsAvailable?: Set<string>;
}

/**
 * Detect the current host context. Cached for the process lifetime.
 */
let cachedHost: HostContext | null = null;

const detectOs = (): string => {
  const p = platform();
  switch (p) {
    case "darwin": return "macos";
    case "linux": return "linux";
    case "win32": return "windows";
    case "freebsd": return "freebsd";
    default: return p;
  }
};

const detectArch = (): string => {
  const a = arch();
  switch (a) {
    case "x64": return "x86_64";
    case "ia32": return "i386";
    case "arm64": return "arm64";
    case "arm": return "armv7";
    default: return a;
  }
};

export const detectHost = (): HostContext => {
  if (cachedHost !== null) return cachedHost;
  cachedHost = {
    os: detectOs(),
    arch: detectArch(),
    envKeys: new Set(Object.keys(process.env)),
  };
  return cachedHost;
};

/**
 * Lazy-detect available shell commands. Calls `command -v <name>` for each
 * requested command. Cached. Skipped on platforms without a POSIX-ish shell.
 *
 * For perf, this should be called ONCE per CLI invocation with the full union
 * of commands referenced by any skill in the bank, not per-skill.
 */
let cachedAvailableCommands: Map<string, boolean> | null = null;

export const detectAvailableCommands = (commands: readonly string[]): Set<string> => {
  if (cachedAvailableCommands === null) cachedAvailableCommands = new Map();
  const available = new Set<string>();
  for (const cmd of commands) {
    if (cachedAvailableCommands.has(cmd)) {
      if (cachedAvailableCommands.get(cmd) === true) available.add(cmd);
      continue;
    }
    let isAvailable = false;
    try {
      execSync(`command -v ${cmd.replace(/[^a-zA-Z0-9_-]/g, "")}`, {
        stdio: "ignore",
        shell: "bash",
      });
      isAvailable = true;
    } catch {
      isAvailable = false;
    }
    cachedAvailableCommands.set(cmd, isAvailable);
    if (isAvailable) available.add(cmd);
  }
  return available;
};

export interface ApplicabilityResult {
  applicable: boolean;
  /** Reasons for inapplicability, empty if applicable. */
  reasons: string[];
}

/**
 * Check whether a skill's applicable_when constraints are satisfied by the
 * given host context. Returns structured result with reasons for debug UX.
 *
 * If `applicable_when` is undefined, returns { applicable: true, reasons: [] }.
 *
 * Constraint semantics:
 *   - os: any-of (skill applies on ANY listed OS)
 *   - arch: any-of
 *   - shell_commands_present: all-of (every listed command MUST be on PATH)
 *   - env_present: all-of
 *   - env_absent: none-of
 */
export const checkApplicability = (
  applicableWhen: ApplicableWhen | undefined,
  host: HostContext,
): ApplicabilityResult => {
  if (applicableWhen === undefined) {
    return { applicable: true, reasons: [] };
  }
  const reasons: string[] = [];

  // os: any-of. If the constraint is declared and the host OS isn't in it, skip.
  if (applicableWhen.os && applicableWhen.os.length > 0) {
    if (!applicableWhen.os.includes(host.os)) {
      reasons.push(`os '${host.os}' not in [${applicableWhen.os.join(", ")}]`);
    }
  }

  // arch: any-of
  if (applicableWhen.arch && applicableWhen.arch.length > 0) {
    if (!applicableWhen.arch.includes(host.arch)) {
      reasons.push(`arch '${host.arch}' not in [${applicableWhen.arch.join(", ")}]`);
    }
  }

  // shell_commands_present: all-of, but ONLY if host populated the set.
  if (
    applicableWhen.shell_commands_present
    && applicableWhen.shell_commands_present.length > 0
    && host.shellCommandsAvailable !== undefined
  ) {
    for (const cmd of applicableWhen.shell_commands_present) {
      if (!host.shellCommandsAvailable.has(cmd)) {
        reasons.push(`required command '${cmd}' not on PATH`);
      }
    }
  }

  // env_present: all-of
  if (applicableWhen.env_present && applicableWhen.env_present.length > 0) {
    for (const name of applicableWhen.env_present) {
      if (!host.envKeys.has(name)) {
        reasons.push(`required env '${name}' not set`);
      }
    }
  }

  // env_absent: none-of (the named vars MUST NOT be set)
  if (applicableWhen.env_absent && applicableWhen.env_absent.length > 0) {
    for (const name of applicableWhen.env_absent) {
      if (host.envKeys.has(name)) {
        reasons.push(`forbidden env '${name}' is set`);
      }
    }
  }

  return { applicable: reasons.length === 0, reasons };
};

/**
 * Test-only helper: reset the host cache (useful when env changes between tests).
 */
export const _resetHostCache = (): void => {
  cachedHost = null;
  cachedAvailableCommands = null;
};
