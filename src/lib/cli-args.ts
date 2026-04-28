// Pure-function CLI argument parsing. Lives in lib/ rather than cli.ts so
// it can be unit-tested without triggering cli.ts's main()-on-import side
// effect (cli.ts is a binary entrypoint with `await main()` at the bottom).

import { CliError, EXIT } from "./errors.js";

export interface Argv {
  positional: string[];
  /**
   * Flags map: key (without leading `--`) → value.
   *  - Boolean flags (no following value, or followed by another `--flag`)
   *    map to literal `true`.
   *  - String flags (`--key value` or `--key=value`) map to the string.
   * The string `"true"` therefore differs from boolean `true` — callers
   * MUST distinguish (`flags.get("k") === true` vs `=== "5"`).
   */
  flags: Map<string, string | boolean>;
}

/**
 * Tokenize a flat argv into positional + flag form. The grammar:
 *
 *   positional   := <any token NOT starting with `--`>
 *   --name=value := flag name=value
 *   --name value := flag name=value, where `value` does NOT start with `--`
 *   --name --next := boolean flag name=true, then process --next
 *   --name (eof) := boolean flag name=true
 *
 * No support for short flags (`-x`), no `--` terminator. Sufficient for
 * agent-skills' surface, which is small + opinionated.
 */
export const parseArgv = (argv: readonly string[]): Argv => {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
        continue;
      }
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(name, true);
      } else {
        flags.set(name, next);
        i++;
      }
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
};

/**
 * Parse the rerank-mode selection from CLI flags. `--no-rerank` always wins
 * over `--rerank-mode` (a more conservative posture for an opt-out flag).
 * Used by both `query` and `bench`.
 *
 * Throws CliError(EXIT.USAGE) on an unknown mode string.
 */
export const parseRerankMode = (
  args: Argv,
): "global" | "intent-conditional" | "none" => {
  let mode: "global" | "intent-conditional" | "none" = "intent-conditional";
  const flag = args.flags.get("rerank-mode");
  if (typeof flag === "string") {
    if (flag === "global" || flag === "intent-conditional" || flag === "none") {
      mode = flag;
    } else {
      throw new CliError(
        EXIT.USAGE,
        `--rerank-mode must be one of: intent-conditional | global | none`,
      );
    }
  }
  if (args.flags.get("no-rerank") === true) mode = "none";
  return mode;
};
