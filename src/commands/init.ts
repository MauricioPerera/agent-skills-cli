// `agent-skills init <name> [--pack]` — scaffold a new skill or a new
// skill pack from embedded templates.
//
// Three modes that share the same scaffold engine:
//
//   1. `init <name>` (default)            — scaffold one skill at
//                                           skills/<name>/SKILL.md.
//      Use case: pack already exists, you want to add a skill to it.
//
//   2. `init --pack <name>`               — scaffold an ENTIRE pack at
//                                           ./<name>/ with skills/,
//                                           llms.txt, README.md,
//                                           .gitignore, and a publish CI
//                                           workflow. The pack starts with
//                                           one skill ("hello-world")
//                                           wired up so `agent-skills
//                                           publish` succeeds immediately.
//      Use case: starting a brand-new skill pack from scratch.
//
//   3. `init <name> --in <dir>`           — same as (1) but in a non-cwd dir.
//
// Design properties:
//   - Embedded templates (no template files on disk) — keeps the CLI a
//     single artifact, no resolution concerns when packaged.
//   - Generated SKILL.md ALWAYS validates against the spec — the template
//     is filled in with placeholder values that are valid (a `pattern` for
//     the example arg, a `command_template` that doesn't reference unset
//     placeholders, etc.). This means the author can run `agent-skills
//     publish --check-only` immediately and see green; THEN edit.
//   - All optional frontmatter fields are present but commented out, with
//     a short prose explanation. This is the discoverability surface for
//     SPEC §2.x without forcing the author to open SPEC.md.
//   - Refuses to overwrite existing files. `--force` opts out per-file.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, EXIT } from "../lib/errors.js";

export interface InitOptions {
  /** Skill id (default mode) or pack name (--pack mode). Validated as a path-segment. */
  name: string;
  /** Scaffold a full pack instead of a single skill. */
  pack?: boolean;
  /** Root directory. Default: "." (cwd). */
  dir?: string;
  /** Inject this as `author.name` and `publisher.name` in templates. */
  authorName?: string;
  /** Allow overwriting existing files. Default: false. */
  force?: boolean;
}

export interface InitResult {
  /** Mode the run was launched in. */
  mode: "skill" | "pack";
  /** Resolved root where files were written. */
  root: string;
  /** Files actually written (relative to root). */
  files_written: string[];
  /** Files skipped because they already exist (and --force wasn't set). */
  files_skipped: string[];
  /** Human-readable suggested follow-ups. */
  next_steps: string[];
}

// ────────────────────────────────────────────────────────────────────
// Template content (string-literal, parametric).
// ────────────────────────────────────────────────────────────────────

const SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Validate a skill name (used as both directory name AND frontmatter `id`).
 * Subset of SPEC §1's path-segment regex `[a-zA-Z0-9_-]+` plus a leading-
 * letter rule (matches typical OSS project name conventions).
 */
const validateName = (name: string, kind: "skill" | "pack"): void => {
  if (!SKILL_NAME_RE.test(name)) {
    throw new CliError(
      EXIT.USAGE,
      `${kind} name '${name}' must match ^[a-zA-Z][a-zA-Z0-9_-]*$ ` +
        `(letter followed by letters / digits / underscores / hyphens)`,
    );
  }
};

const skillTemplate = (id: string, authorName: string | undefined): string => {
  // Title-case from the id for the human-readable title.
  const title = id
    .split(/[-_]/)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join(" ");

  const authorBlock = authorName
    ? `author:\n  name: ${JSON.stringify(authorName)}\n  url: "https://example.com"\n`
    : `# author:\n#   name: "Your Name"\n#   url: "https://example.com"\n`;

  return `---
# ─── Required (SPEC §2.2) ─────────────────────────────────────────────
schema_version: "0.1"
id: "${id}"
version: "1.0.0"
title: "${title}"
description: "What this skill does, in one paragraph. Keep it concrete and outcome-oriented."
use_when: "the user wants to <do the thing this skill does>"

# ─── The command (SPEC §2.5–2.6) ──────────────────────────────────────
# Reference {placeholders} from args below. Per SPEC §2.6, placeholders
# MUST appear in argument position (NEVER inside literal "..." or '...').
# Reference env vars as $VAR_NAME — they're expanded by bash at exec time,
# never seen by the agent (privacy invariant P1).
command_template: "echo {message}"

# ─── Args (SPEC §2.4) ─────────────────────────────────────────────────
args:
  message:
    type: string
    description: "the text to echo"
    pattern: "^[\\\\w .,!?-]{1,200}$"     # whitelist what shell will see
    # default: "hello world"               # provide if optional
    # sensitive: true                      # redact in audit log
    # unquoted: true                       # bypass single-quoting (DANGEROUS — needs strict pattern)

# ─── Optional metadata (SPEC §2.3) ────────────────────────────────────
${authorBlock}license: "MIT"
# tags: ["example", "starter"]
# category: "shell"
# idempotent: true                  # safe to retry; chain executors will

# ─── applicable_when (SPEC §2.7) ──────────────────────────────────────
# Banks may filter results that fail these conditions on the host.
# applicable_when:
#   os: ["linux", "macos", "windows"]
#   arch: ["x86_64", "arm64"]
#   shell_commands_present: ["echo"]
#   env_present: []          # required env vars (e.g., ["GH_TOKEN"])
#   env_absent: []           # forbidden env vars (e.g., ["DRY_RUN"])

# ─── network policy (SPEC §2.8) ───────────────────────────────────────
# Banks SHOULD honour this when sandboxing exec.
# network:
#   egress: "none"           # none | allowlist
#   allowlist: []            # list of host:port (when egress=allowlist)

# ─── Examples (SPEC §2.9) ─────────────────────────────────────────────
# Past intent → expected args. Used for retrieval-quality benchmarking.
# examples:
#   - intent: "echo hello world"
#     args: { message: "hello world" }
---

# ${title}

Replace this section with a human-readable explanation of what the skill does,
edge cases, and any caveats an agent should know about. The body is OPTIONAL
per SPEC §2.1 but recommended for discoverability and audit transparency.

## Examples

\`\`\`bash
agent-skills exec ${id} --args '{"message":"hello world"}'
# → hello world
\`\`\`

## Notes

- Idempotent: yes. Safe to retry.
- Network: none.
- Sensitive args: none.
`;
};

const llmsTxtTemplate = (packName: string, authorName?: string): string => `# ${packName}

> A pack of agent-skills.

${authorName ? `By ${authorName}.\n\n` : ""}This pack follows the [agent-skills v0.1 specification](https://github.com/MauricioPerera/agent-skills) and ships:

- One or more \`SKILL.md\` files under \`skills/\`.
- A \`skills-index.json\` (managed by \`agent-skills publish\`).

## Skills

- [skills/hello-world/SKILL.md](skills/hello-world/SKILL.md) — example starter skill.

## How to use

\`\`\`bash
# As a consumer:
agent-skills sync github.com/<owner>/${packName}

# As a fork author:
agent-skills publish --check-only      # validate
agent-skills publish --tag v1.0.0 --sign
git push --follow-tags
\`\`\`
`;

const readmeTemplate = (packName: string, authorName?: string): string => `# ${packName}

> A pack of agent-skills.

${authorName ? `Maintained by ${authorName}.\n\n` : ""}## What's in here

| Skill | Purpose |
|---|---|
| [\`hello-world\`](skills/hello-world/SKILL.md) | Starter skill — echoes a message |

## Add a skill

\`\`\`bash
agent-skills init my-new-skill
# edit skills/my-new-skill/SKILL.md
agent-skills publish --check-only      # validate
git add . && git commit -m "Add my-new-skill"
agent-skills publish --tag v1.1.0 --sign
git push --follow-tags
\`\`\`

## Specification

This pack conforms to the [agent-skills v0.1 specification](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md).

## License

[MIT](./LICENSE)
`;

const gitignoreTemplate = (): string => `# Local agent-skills bank state (if you sync this pack into your own bank for testing)
.agent-skills-bank/

# OS metadata
.DS_Store
Thumbs.db

# Editor scratch
*.swp
*~
.vscode/
.idea/
`;

const ciWorkflowTemplate = (packName: string): string => `name: validate

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      # Until agent-skills-cli is on npm, install from a tagged release.
      - name: Install agent-skills CLI
        run: |
          git clone --depth 1 --branch v0.13.1 https://github.com/MauricioPerera/agent-skills-cli /tmp/cli
          cd /tmp/cli && npm ci && npm run build && npm link

      - name: Validate every SKILL.md and confirm skills-index.json is up-to-date
        run: |
          cd \$GITHUB_WORKSPACE
          agent-skills publish --check-only
        # Exit 5 if any SKILL.md is invalid; exit 0 even on a clean no-op.
        # Add --json | jq for richer CI output if needed.

  # Optional: bench the pack against a truth file once you have one.
  # bench:
  #   runs-on: ubuntu-latest
  #   needs: validate
  #   steps:
  #     - uses: actions/checkout@v4
  #     - uses: actions/setup-node@v4
  #       with: { node-version: "22" }
  #     - name: Install + sync + bench
  #       env:
  #         CF_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}
  #         CF_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
  #       run: |
  #         git clone --depth 1 --branch v0.8.0 https://github.com/MauricioPerera/agent-skills-cli /tmp/cli
  #         cd /tmp/cli && npm ci && npm run build && npm link
  #         agent-skills sync github.com/\${{ github.repository }}@\${{ github.sha }}
  #         agent-skills bench bench-truth.jsonl
`;

// ────────────────────────────────────────────────────────────────────
// Scaffold engine
// ────────────────────────────────────────────────────────────────────

interface ScaffoldFile {
  /** Path relative to the run root. */
  path: string;
  /** Content. */
  content: string;
  /** Optional follow-up suggestion to include in next_steps. */
  hint?: string;
}

const writeIfAbsent = async (
  root: string,
  files: readonly ScaffoldFile[],
  force: boolean,
): Promise<{ written: string[]; skipped: string[] }> => {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const fullPath = join(root, f.path);
    let exists = false;
    try {
      await readFile(fullPath, "utf8");
      exists = true;
    } catch {
      // doesn't exist — proceed
    }
    if (exists && !force) {
      skipped.push(f.path);
      continue;
    }
    // Make sure the parent dir exists.
    const lastSlash = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
    if (lastSlash >= 0) await mkdir(fullPath.slice(0, lastSlash), { recursive: true });
    await writeFile(fullPath, f.content, "utf8");
    written.push(f.path);
  }
  return { written, skipped };
};

export const runInit = async (opts: InitOptions): Promise<InitResult> => {
  const mode: "skill" | "pack" = opts.pack === true ? "pack" : "skill";
  validateName(opts.name, mode);

  const force = opts.force === true;
  const cwd = opts.dir ?? ".";

  if (mode === "skill") {
    const root = cwd;
    const files: ScaffoldFile[] = [
      {
        path: join("skills", opts.name, "SKILL.md"),
        content: skillTemplate(opts.name, opts.authorName),
      },
    ];
    const { written, skipped } = await writeIfAbsent(root, files, force);

    const nextSteps: string[] = [];
    if (written.length > 0) {
      nextSteps.push(`edit ${join("skills", opts.name, "SKILL.md")}`);
      nextSteps.push(`agent-skills publish --check-only   # validate + refresh skills-index.json`);
    } else if (skipped.length > 0) {
      nextSteps.push(`pass --force to overwrite the existing file(s)`);
    }

    return {
      mode,
      root,
      files_written: written,
      files_skipped: skipped,
      next_steps: nextSteps,
    };
  }

  // Pack mode: scaffold an entire pack rooted at <cwd>/<name>.
  const root = join(cwd, opts.name);
  const files: ScaffoldFile[] = [
    {
      path: join("skills", "hello-world", "SKILL.md"),
      content: skillTemplate("hello-world", opts.authorName),
    },
    {
      path: "llms.txt",
      content: llmsTxtTemplate(opts.name, opts.authorName),
    },
    {
      path: "README.md",
      content: readmeTemplate(opts.name, opts.authorName),
    },
    {
      path: ".gitignore",
      content: gitignoreTemplate(),
    },
    {
      path: join(".github", "workflows", "validate.yml"),
      content: ciWorkflowTemplate(opts.name),
    },
  ];
  const { written, skipped } = await writeIfAbsent(root, files, force);

  const nextSteps: string[] = [];
  if (written.length > 0) {
    nextSteps.push(`cd ${opts.name}`);
    nextSteps.push(`agent-skills publish --check-only   # should be a clean validation`);
    nextSteps.push(`git init && git add . && git commit -m "Initial pack"`);
    nextSteps.push(`# Then add the GitHub topic 'agent-skills' and publish a tagged release.`);
  } else if (skipped.length > 0) {
    nextSteps.push(`pass --force to overwrite the existing file(s)`);
  }

  return {
    mode,
    root,
    files_written: written,
    files_skipped: skipped,
    next_steps: nextSteps,
  };
};

export const printInitResult = (result: InitResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`init ${result.mode}: ${result.root}\n`);
  if (result.files_written.length > 0) {
    process.stdout.write(`\nWrote ${result.files_written.length} file(s):\n`);
    for (const f of result.files_written) process.stdout.write(`  + ${f}\n`);
  }
  if (result.files_skipped.length > 0) {
    process.stdout.write(`\nSkipped ${result.files_skipped.length} existing file(s):\n`);
    for (const f of result.files_skipped) process.stdout.write(`  - ${f}\n`);
  }
  if (result.next_steps.length > 0) {
    process.stdout.write(`\nNext:\n`);
    for (const step of result.next_steps) process.stdout.write(`  ${step}\n`);
  }
};
