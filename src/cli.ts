// CLI entrypoint for `agent-skills`. Invoked via the bin shim in package.json.

import { FileBank, defaultBankRoot } from "./lib/bank.js";
import { createCloudflareEmbedder } from "./lib/embed.js";
import { CliError, EXIT, isCliError } from "./lib/errors.js";
import { printResolveResult, runResolve } from "./commands/resolve.js";
import { printValidateResult, runValidate } from "./commands/validate.js";
import { runSync } from "./commands/sync.js";
import { printQueryResult, runQuery } from "./commands/query.js";
import { printExecResult, runExec } from "./commands/exec.js";

const VERSION = "0.4.0";

const HELP = `agent-skills v${VERSION} — reference CLI for the agent-skills specification

Usage:
  agent-skills <command> [args] [flags]

Commands (local, no network):
  validate <file>                  Validate a SKILL.md against the spec.
  resolve <file> --args <json>     Substitute placeholders and print the
                                   resolved command (does NOT execute).

Commands (network — require Cloudflare Workers AI credentials):
  sync <repo>[@<ref>]              Fetch + embed + index skills from a git source.
                                   Default ref: main.
  query "<intent>" [--k N]         Find the top-K skills matching an intent.

Commands (local, no embedding API needed):
  exec <skill> --args <json>       Substitute placeholders + execute via bash.
                                   <skill> = full identity OR short id (e.g., "http-get").
  audit [--limit N] [--skill <id>] Print recent audit entries from the bank.
  list                             List all subscriptions in the local bank.
  reset                            Wipe all bank state (asks for confirmation).

Other:
  help                             Show this help.
  version                          Print version.

Flags (per command):
  --json                Output machine-readable JSON instead of text.
  --skip-validation     (resolve only) Skip schema validation before substituting.
  --k N                 (query) Top-K hits to return. Default 5.
  --bank-dir <path>     Override default bank state directory.
  --dry-run             (exec) Resolve + validate but do NOT execute. Print the command.
  --timeout-sec N       (exec) Hard timeout. Default 60.
  --no-audit            (exec) Skip audit log entry.
  --intent "<text>"     (exec) Record this intent in the audit entry.
  --limit N             (audit) Max entries to print. Default 20.
  --skill <id>          (audit) Filter to one skill identity.
  --no-rerank           (query) Disable audit-based re-rank. Default: rerank ON.
  --no-filter           (query) Disable applicable_when filtering. Default: filter ON.

Cloudflare Workers AI environment (for sync + query):
  CF_ACCOUNT_ID         Your Cloudflare account ID (32 hex chars).
  CF_API_TOKEN          API token with Workers AI permission.
  CF_EMBEDDING_MODEL    Optional model override; default: @cf/baai/bge-base-en-v1.5
                        Other options: @cf/baai/bge-small-en-v1.5 (384-dim, faster)
                                       @cf/baai/bge-large-en-v1.5 (1024-dim, slower)
                                       @cf/baai/bge-m3            (1024-dim, multilingual)

Default bank state: ${defaultBankRoot()}

Examples:
  # Validate
  agent-skills validate skills/x/SKILL.md

  # Resolve (substitute args, don't execute)
  agent-skills resolve skills/x/SKILL.md --args '{"amount":1000}'

  # Sync a public skill pack
  export CF_ACCOUNT_ID=...
  export CF_API_TOKEN=...
  agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0

  # Query — find skills matching an intent
  agent-skills query "I need to fetch data from a URL"

Exit codes:
  0 success
  1 runtime error
  2 usage error (missing arg, malformed flag)
  3 not found (file or remote resource unreachable)
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

  // Network commands below — require bank + embedder
  const bankDir = args.flags.get("bank-dir");
  const bank = new FileBank({
    rootDir: typeof bankDir === "string" ? bankDir : undefined,
  });

  if (cmd === "list") {
    const subs = await bank.listSubscriptions();
    const meta = await bank.getMeta();
    if (asJson) {
      process.stdout.write(JSON.stringify({ bank_root: bank.root, meta, subscriptions: subs }) + "\n");
    } else {
      process.stdout.write(`Bank: ${bank.root}\n`);
      if (meta) {
        process.stdout.write(`Embedding: ${meta.embedding_model} (${meta.embedding_dim}-dim)\n`);
      } else {
        process.stdout.write(`Embedding: (not yet initialized)\n`);
      }
      process.stdout.write(`Subscriptions: ${subs.length}\n`);
      for (const s of subs) {
        process.stdout.write(`  - ${s.id}\n`);
        process.stdout.write(`    repo: ${s.repo ?? "n/a"}\n`);
        process.stdout.write(`    requested: ${s.ref_requested ?? "n/a"}\n`);
        process.stdout.write(`    resolved:  ${s.ref_resolved ?? "(not synced yet)"}\n`);
        process.stdout.write(`    last_synced: ${s.last_synced ?? "(never)"}\n`);
      }
    }
    process.exit(EXIT.OK);
  }

  if (cmd === "reset") {
    if (args.flags.get("yes") !== true) {
      throw new CliError(
        EXIT.USAGE,
        `reset will DELETE all bank state at ${bank.root}. Pass --yes to confirm.`,
      );
    }
    await bank.reset();
    process.stdout.write(`reset: ${bank.root} cleared\n`);
    process.exit(EXIT.OK);
  }

  // Embedder is needed for sync + query
  const accountId = process.env["CF_ACCOUNT_ID"];
  const apiToken = process.env["CF_API_TOKEN"];
  const embeddingModel = process.env["CF_EMBEDDING_MODEL"];

  if (cmd === "sync" || cmd === "query") {
    if (!accountId || !apiToken) {
      throw new CliError(
        EXIT.AUTH,
        `${cmd}: CF_ACCOUNT_ID and CF_API_TOKEN env vars are required.\nGet them at https://dash.cloudflare.com/profile/api-tokens (token needs 'Workers AI' permission).`,
      );
    }
  }

  if (cmd === "sync") {
    const source = args.positional[1];
    if (source === undefined) {
      throw new CliError(EXIT.USAGE, "sync: missing <repo>[@<ref>] argument");
    }
    const embedder = createCloudflareEmbedder({
      accountId: accountId as string,
      apiToken: apiToken as string,
      model: embeddingModel,
    });
    const result = await runSync({ source, bank, embedder });
    if (asJson) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(`Synced ${result.source}\n`);
      process.stdout.write(`  ref: ${result.ref_requested} → ${result.ref_resolved}\n`);
      process.stdout.write(`  total: ${result.total} | synced: ${result.synced} | invalid: ${result.invalid} | errored: ${result.errored}\n\n`);
      for (const r of result.skills) {
        const icon = r.status === "synced" ? "✓" : r.status === "invalid" ? "✗" : "!";
        process.stdout.write(`  ${icon} ${r.id}`);
        if (r.message) process.stdout.write(` — ${r.message}`);
        process.stdout.write("\n");
        if (r.errors) {
          for (const e of r.errors) process.stdout.write(`     ${e.path}: ${e.message}\n`);
        }
      }
    }
    process.exit(result.errored > 0 ? EXIT.RUNTIME : EXIT.OK);
  }

  if (cmd === "query") {
    const intent = args.positional[1];
    if (intent === undefined) {
      throw new CliError(EXIT.USAGE, 'query: missing "<intent>" argument');
    }
    const kFlag = args.flags.get("k");
    const k = typeof kFlag === "string" ? Number(kFlag) : undefined;
    const noRerank = args.flags.get("no-rerank") === true;
    const noFilter = args.flags.get("no-filter") === true;
    const embedder = createCloudflareEmbedder({
      accountId: accountId as string,
      apiToken: apiToken as string,
      model: embeddingModel,
    });
    const result = await runQuery({
      intent,
      k,
      bank,
      embedder,
      rerank: !noRerank,
      filterApplicable: !noFilter,
    });
    printQueryResult(result, asJson);
    process.exit(EXIT.OK);
  }

  if (cmd === "exec") {
    const skillIdentifier = args.positional[1];
    if (skillIdentifier === undefined) {
      throw new CliError(EXIT.USAGE, "exec: missing <skill> argument (full identity or short id)");
    }
    const argsJson = args.flags.get("args");
    if (typeof argsJson !== "string") {
      throw new CliError(
        EXIT.USAGE,
        "exec: missing --args <json>; use --args '{}' for a no-arg skill",
      );
    }
    let argsObj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(argsJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--args must be a JSON object");
      }
      argsObj = parsed as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(EXIT.USAGE, `invalid --args JSON: ${msg}`);
    }

    const dryRun = args.flags.get("dry-run") === true;
    const noAudit = args.flags.get("no-audit") === true;
    const timeoutFlag = args.flags.get("timeout-sec");
    const timeoutSec = typeof timeoutFlag === "string" ? Number(timeoutFlag) : undefined;
    const intentFlag = args.flags.get("intent");
    const intent = typeof intentFlag === "string" ? intentFlag : undefined;

    const result = await runExec({
      bank,
      skillIdentifier,
      args: argsObj,
      dryRun,
      timeoutSec,
      noAudit,
      intent,
    });

    if (dryRun) {
      // Always print the resolved command in dry-run mode (regardless of --json)
      if (asJson) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        process.stdout.write(`[dry-run] resolved skill: ${result.skill_identity}\n`);
        process.stdout.write(`[dry-run] command:\n  ${result.command}\n`);
      }
      process.exit(EXIT.OK);
    }

    printExecResult(result, asJson);
    process.exit(result.exit_code);
  }

  if (cmd === "audit") {
    const limitFlag = args.flags.get("limit");
    const limit = typeof limitFlag === "string" ? Number(limitFlag) : 20;
    const skillFilterFlag = args.flags.get("skill");
    const skill_id = typeof skillFilterFlag === "string" ? skillFilterFlag : undefined;
    const opts: { limit?: number; skill_id?: string } = { limit };
    if (skill_id !== undefined) opts.skill_id = skill_id;
    const entries = await bank.listAudit(opts);
    if (asJson) {
      process.stdout.write(JSON.stringify(entries) + "\n");
    } else if (entries.length === 0) {
      process.stdout.write("(no audit entries)\n");
    } else {
      for (const e of entries) {
        const status = e.exit_code === 0 ? "✓" : `✗ exit=${e.exit_code}`;
        process.stdout.write(`${e.timestamp}  ${status}  ${e.skill_id}  (${e.elapsed_ms}ms)\n`);
        if (e.intent !== undefined) process.stdout.write(`    intent: ${e.intent}\n`);
      }
    }
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
