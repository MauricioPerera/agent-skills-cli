// CLI entrypoint for `agent-skills`. Invoked via the bin shim in package.json.

import { CliError, EXIT, isCliError } from "./lib/errors.js";
import { printResolveResult, runResolve } from "./commands/resolve.js";
import { printValidateResult, runValidate } from "./commands/validate.js";

const VERSION = "0.2.0-alpha.0";

const HELP = `agent-skills v${VERSION} — reference CLI for the agent-skills specification

Usage:
  agent-skills <command> [args] [flags]

Commands:
  validate <file>                  Validate a SKILL.md against the spec.
  resolve <file> --args <json>     Substitute placeholders and print the
                                   resolved command (does NOT execute).
  help                             Show this help.
  version                          Print version.

Flags (per command):
  --json                Output machine-readable JSON instead of text.
  --skip-validation     (resolve only) Skip schema validation before substituting.
                        NOT RECOMMENDED — exists for testing non-conformant skills.

Examples:
  agent-skills validate skills/charge-customer/SKILL.md
  agent-skills resolve skills/charge-customer/SKILL.md \\
    --args '{"amount":1000,"currency":"usd","customer_id":"cus_X"}'

Exit codes:
  0 success
  1 runtime error
  2 usage error (missing arg, malformed flag, etc.)
  3 not found (file unreadable)
  5 validation error (skill non-conformant, args invalid)

Spec: https://github.com/MauricioPerera/agent-skills
`;

interface Argv {
  positional: string[];
  flags: Map<string, string | boolean>;
}

const parseArgv = (argv: readonly string[]): Argv => {
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

const main = async (): Promise<void> => {
  const args = parseArgv(process.argv.slice(2));
  const cmd = args.positional[0];

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT.OK);
  }

  const asJson = args.flags.get("json") === true;

  if (cmd === "validate") {
    const file = args.positional[1];
    if (file === undefined) {
      throw new CliError(EXIT.USAGE, "validate: missing <file> argument");
    }
    const result = await runValidate({ file, json: asJson });
    printValidateResult(result, asJson);
    process.exit(result.valid ? EXIT.OK : EXIT.VALIDATION);
  }

  if (cmd === "resolve") {
    const file = args.positional[1];
    if (file === undefined) {
      throw new CliError(EXIT.USAGE, "resolve: missing <file> argument");
    }
    const argsJson = args.flags.get("args");
    if (typeof argsJson !== "string") {
      throw new CliError(
        EXIT.USAGE,
        "resolve: missing --args <json>; use --args '{}' to pass an empty object",
      );
    }
    const skipValidation = args.flags.get("skip-validation") === true;
    const result = await runResolve({
      file,
      argsJson,
      json: asJson,
      skipValidation,
    });
    printResolveResult(result, asJson);
    process.exit(EXIT.OK);
  }

  throw new CliError(
    EXIT.USAGE,
    `unknown command '${cmd}'. Run 'agent-skills help' for usage.`,
  );
};

main().catch((err: unknown) => {
  if (isCliError(err)) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`runtime error: ${msg}\n`);
  process.exit(EXIT.RUNTIME);
});
