// CLI entrypoint for `agent-skills`. Invoked via the bin shim in package.json.

import { FileBank, defaultBankRoot } from "./lib/bank.js";
import { resolveEmbedderFromEnv } from "./lib/embed.js";
import { CliError, EXIT, isCliError } from "./lib/errors.js";
import { printResolveResult, runResolve } from "./commands/resolve.js";
import { printValidateResult, runValidate } from "./commands/validate.js";
import { runSync } from "./commands/sync.js";
import { printQueryResult, runQuery } from "./commands/query.js";
import { printExecResult, runExec } from "./commands/exec.js";
import { printBenchResult, runBench } from "./commands/bench.js";
import { printPublishResult, runPublish } from "./commands/publish.js";

const VERSION = "0.8.0";

const HELP = `agent-skills v${VERSION} — reference CLI for the agent-skills specification

Usage:
  agent-skills <command> [args] [flags]

Commands (local, no network):
  validate <file>                  Validate a SKILL.md against the spec.
  resolve <file> --args <json>     Substitute placeholders and print the
                                   resolved command (does NOT execute).

Commands (need an embedding provider — see ENV section below):
  sync <repo>[@<ref>]              Fetch + embed + index skills from a git source.
                                   Default ref: main.
  query "<intent>" [--k N]         Find the top-K skills matching an intent.
  bench <truth-file> [--k N]       Measure retrieval accuracy against a ground-truth
                                   file of (intent, expected_id) pairs.

Commands (local, no embedding API needed):
  exec <skill> --args <json>       Substitute placeholders + execute via bash.
                                   <skill> = full identity OR short id (e.g., "http-get").
  audit [--limit N] [--skill <id>] Print recent audit entries from the bank.
  list                             List all subscriptions in the local bank.
  reset                            Wipe all bank state (asks for confirmation).

Author commands (local, no bank needed):
  publish [<dir>]                  Validate skills/, generate skills-index.json,
                                   optionally git tag. Use in your skill-pack repo.

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
  --rerank-mode <m>     (query) Rerank strategy: intent-conditional (default,
                        v0.5.0+) | global (v0.4.0 behavior) | none.
  --embedding-provider <p>  (sync, query) Override env auto-detect.
                        Valid: cloudflare | ollama | openai.
  --check-only          (publish) Validate but don't write or tag. CI-friendly.
  --tag <version>       (publish) Create git tag at HEAD with this version.
  --sign                (publish) Sign the git tag (git tag -s). Requires GPG.
  --repo <repo>         (publish) Set default_source.repo (e.g., github.com/me/pack).
                        Used on first publish; existing index wins on re-publish.
  --branch <name>       (publish) Set default_source.default_branch. Default: main.
  --ref <ref>           (publish) Set latest_release for resolved skill URLs (e.g., v1.0.0).

Embedding providers (v0.6.0+ — auto-detected from env, or set EMBEDDING_PROVIDER):

  Cloudflare Workers AI (free tier available):
    CF_ACCOUNT_ID       Your Cloudflare account ID (32 hex chars).
    CF_API_TOKEN        API token with Workers AI permission.
    CF_EMBEDDING_MODEL  Optional. Default @cf/baai/bge-base-en-v1.5 (768-dim).
                        Others: @cf/baai/bge-small-en-v1.5 (384), bge-large-en-v1.5 (1024), bge-m3 (1024, multilingual).

  Ollama (local, zero credentials, zero network egress):
    OLLAMA_BASE_URL     Default http://localhost:11434.
    OLLAMA_MODEL        Default nomic-embed-text (768-dim).
                        Others: mxbai-embed-large (1024), all-minilm (384), bge-m3 (1024).
    OLLAMA_DIM          Override the auto-detected dim (only needed for unknown models).
    Setup:              ollama pull nomic-embed-text

  OpenAI (or any OpenAI-compatible /v1/embeddings server):
    OPENAI_API_KEY      Required.
    OPENAI_BASE_URL     Default https://api.openai.com/v1. Override for Together,
                        Anyscale, Mistral, vLLM, infinity, TEI, etc.
    OPENAI_MODEL        Default text-embedding-3-small (1536-dim).
                        Others: text-embedding-3-large (3072), text-embedding-ada-002 (1536).
    OPENAI_DIM          Optional. For text-embedding-3-* sets the truncated dim.

  Auto-detect priority: CF_* > OPENAI_API_KEY > OLLAMA_*. Override with EMBEDDING_PROVIDER.

Default bank state: ${defaultBankRoot()}

Examples:
  # Validate
  agent-skills validate skills/x/SKILL.md

  # Resolve (substitute args, don't execute)
  agent-skills resolve skills/x/SKILL.md --args '{"amount":1000}'

  # Sync via local Ollama (zero credentials)
  ollama pull nomic-embed-text
  EMBEDDING_PROVIDER=ollama agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0

  # Sync via Cloudflare Workers AI
  export CF_ACCOUNT_ID=... CF_API_TOKEN=...
  agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0

  # Query — find skills matching an intent
  agent-skills query "I need to fetch data from a URL"

  # Bench — measure top-K accuracy against a ground-truth file
  agent-skills bench truth.jsonl
  agent-skills bench truth.jsonl --rerank-mode global --json | jq .top1

Exit codes:
  0 success
  1 runtime error (also: bench had ≥1 failed query)
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

  if (cmd === "publish") {
    const dir = args.positional[1] ?? ".";
    const checkOnly = args.flags.get("check-only") === true;
    const sign = args.flags.get("sign") === true;
    const tag = args.flags.get("tag");
    const repo = args.flags.get("repo");
    const branch = args.flags.get("branch");
    const ref = args.flags.get("ref");
    const result = await runPublish({
      dir,
      checkOnly,
      sign,
      tag: typeof tag === "string" ? tag : undefined,
      repo: typeof repo === "string" ? repo : undefined,
      branch: typeof branch === "string" ? branch : undefined,
      ref: typeof ref === "string" ? ref : undefined,
    });
    printPublishResult(result, asJson);
    // Non-zero on validation failures so CI blocks bad releases.
    process.exit(result.invalid + result.errored > 0 ? EXIT.VALIDATION : EXIT.OK);
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

  // Embedder is resolved from env (auto-detect: cloudflare | ollama | openai).
  // CLI flag --embedding-provider <name> can override; passes through to the resolver.
  const providerFlag = args.flags.get("embedding-provider");
  let providerOverride: "cloudflare" | "ollama" | "openai" | undefined;
  if (typeof providerFlag === "string") {
    if (providerFlag === "cloudflare" || providerFlag === "ollama" || providerFlag === "openai") {
      providerOverride = providerFlag;
    } else {
      throw new CliError(
        EXIT.USAGE,
        `--embedding-provider must be one of: cloudflare | ollama | openai`,
      );
    }
  }

  if (cmd === "sync") {
    const source = args.positional[1];
    if (source === undefined) {
      throw new CliError(EXIT.USAGE, "sync: missing <repo>[@<ref>] argument");
    }
    const embedder = resolveEmbedderFromEnv({ provider: providerOverride });
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
    const rerankModeFlag = args.flags.get("rerank-mode");
    let rerankMode: "global" | "intent-conditional" | "none" = "intent-conditional";
    if (typeof rerankModeFlag === "string") {
      if (rerankModeFlag === "global" || rerankModeFlag === "intent-conditional" || rerankModeFlag === "none") {
        rerankMode = rerankModeFlag;
      } else {
        throw new CliError(EXIT.USAGE, `--rerank-mode must be one of: intent-conditional | global | none`);
      }
    }
    if (noRerank) rerankMode = "none";
    const embedder = resolveEmbedderFromEnv({ provider: providerOverride });
    const result = await runQuery({
      intent,
      k,
      bank,
      embedder,
      rerankMode,
      filterApplicable: !noFilter,
    });
    printQueryResult(result, asJson);
    process.exit(EXIT.OK);
  }

  if (cmd === "bench") {
    const truthFile = args.positional[1];
    if (truthFile === undefined) {
      throw new CliError(EXIT.USAGE, "bench: missing <truth-file> argument");
    }
    const kFlag = args.flags.get("k");
    const k = typeof kFlag === "string" ? Number(kFlag) : undefined;
    const noFilter = args.flags.get("no-filter") === true;
    const noRerank = args.flags.get("no-rerank") === true;
    const rerankModeFlag = args.flags.get("rerank-mode");
    let rerankMode: "global" | "intent-conditional" | "none" = "intent-conditional";
    if (typeof rerankModeFlag === "string") {
      if (rerankModeFlag === "global" || rerankModeFlag === "intent-conditional" || rerankModeFlag === "none") {
        rerankMode = rerankModeFlag;
      } else {
        throw new CliError(EXIT.USAGE, `--rerank-mode must be one of: intent-conditional | global | none`);
      }
    }
    if (noRerank) rerankMode = "none";
    const embedder = resolveEmbedderFromEnv({ provider: providerOverride });
    const result = await runBench({
      truthFile,
      bank,
      embedder,
      k,
      rerankMode,
      filterApplicable: !noFilter,
    });
    printBenchResult(result, asJson);
    // Non-zero exit when any failure is present, so CI treats <100% top-1 as a regression.
    process.exit(result.failures.length > 0 ? EXIT.RUNTIME : EXIT.OK);
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
