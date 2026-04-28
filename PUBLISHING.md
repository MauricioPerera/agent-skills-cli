# Publishing your first agent-skills pack

A tutorial for the case "I have an internal tool, I want my agent (or someone else's agent) to find and use it." Walks end-to-end from empty directory to a working pack other people can subscribe to.

**Time required:** 20–30 minutes for someone who has used Node and git before.

**Outcome:** a public GitHub repo with a tagged release that anyone can `sync` into their bank and an agent will retrieve over natural-language queries like *"summarize a GitHub PR"* or *"show open issues in repo X"*.

If you only want to read the spec, see the [main README](./README.md) and [SPEC.md](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md). This document is the **doer's path**.

---

## What you'll build

A small but realistic pack with one skill: `gh-pr-summary` — a wrapper over `gh pr view` that an agent can invoke when the user says something like *"summarize PR 123 in repo foo/bar"*.

Why this example: it's small (one shell command), exercises every concept (frontmatter, args, env vars, the privacy invariant), and is genuinely useful — agents *should* know how to summarize PRs without prompting the user for the exact `gh` invocation.

If your tool is different, the shape stays the same; only the `command_template` changes.

---

## Prerequisites

- **Node ≥ 22** (`node --version`)
- **git** + a GitHub account with push access to a repo you own
- **The CLI installed:**

  ```bash
  npm install -g @rckflr/agent-skills-cli
  agent-skills --version  # 0.18.1 or later
  ```

- **For the example skill:** the [GitHub CLI (`gh`)](https://cli.github.com/) authenticated. The skill we're writing wraps `gh pr view`, so the running environment needs it. Authors don't need any special tooling beyond the CLI above.

---

## Step 1 — Scaffold the pack

Pick a directory name (this becomes your repo name; choose deliberately, it's discoverable):

```bash
mkdir my-skill-pack
cd my-skill-pack
agent-skills init . --pack --author "Your Name <you@example.com>"
```

You'll get:

```
.
├── README.md                         ← describe the pack to humans
├── llms.txt                          ← describe it to LLMs (optional but recommended)
├── skills/
│   └── hello-world/
│       └── SKILL.md                  ← scaffolded example, replace it
├── skills-index.json                 ← auto-maintained; don't edit by hand
└── .github/workflows/validate.yml    ← CI: validate every SKILL.md on every push
```

The scaffolded `hello-world` SKILL.md is a learning artifact. We'll replace it with something real.

---

## Step 2 — Write your first skill

Delete the placeholder and create your actual skill:

```bash
rm -rf skills/hello-world
mkdir -p skills/gh-pr-summary
```

Open `skills/gh-pr-summary/SKILL.md` in your editor and write:

````markdown
---
schema_version: "0.1"
id: gh-pr-summary
name: Summarize a GitHub pull request
description: |
  Fetches a GitHub pull request and emits a concise summary
  (title, author, status, modified files, conversation excerpt).
  Useful when a user says "summarize PR X" or "what's PR Y about"
  and you need the full PR context before answering.
keywords: [github, pull-request, pr, summary, code-review, gh]
authors:
  - name: Your Name
    email: you@example.com
license: MIT
version: "0.1.0"

# What kind of host this skill needs.
applicable_when:
  commands_available: [gh]
  env_present: []                # gh handles its own auth via `gh auth login`

# How an agent invokes the skill.
command_template: gh pr view {pr_url} --json number,title,author,state,files,comments | jq

args:
  - name: pr_url
    description: Full URL or `owner/repo#NUMBER` of the PR to summarize.
    type: string
    required: true
    example: "https://github.com/cli/cli/pull/9000"
---

# When to use this skill

Use this skill whenever the user references a GitHub PR by URL, by `owner/repo#N`,
or by number when the active repo context is clear. Output is JSON; pass it through
to your model to extract the relevant parts (title, body excerpt, file list).

# When NOT to use it

- The user is asking about an **issue**, not a PR — use `gh issue view` instead.
- The repo is on Bitbucket / GitLab — `gh` won't work; surface that to the user.
- The user wants to **modify** the PR (comment, merge, close) — read-only skill.

# Examples

- *"What's PR cli/cli#9000 about?"* → `pr_url: https://github.com/cli/cli/pull/9000`
- *"Summarize the PR for the auth refactor in our repo"* → resolve to a URL first
  (likely via another skill or the user's clarification), then invoke this.
````

A few things to notice:

- **`description`** is the field most retrieval models lean on. Be specific about the *job to be done*, not the implementation. "Summarizes a GitHub pull request" is better than "Wraps gh pr view".
- **`applicable_when.commands_available`** filters out hosts where `gh` isn't installed. Banks check this before showing the skill to the agent.
- **`command_template`** uses `{pr_url}` interpolation. The CLI quotes the substituted value safely (`echo 'hello world'`-style single quotes; SPEC §2.6).
- **`args[].example`** matters: it shows up in retrieval examples and helps the agent get the call right.

---

## Step 3 — Validate locally

```bash
agent-skills publish --check-only
```

You should see something like:

```
✓ skills/gh-pr-summary/SKILL.md valid
1 skill, 0 invalid, 0 errored
```

If you see errors, the messages point at the field. Common ones:

- `id must match [a-z][a-z0-9-]*` — lowercase, dashes only.
- `description is required` — fill it in. Quality of retrieval depends on it.
- `command_template references arg "X" which is not declared in args` — name mismatch between `{X}` and `args[].name`.

Once it's clean, regenerate `skills-index.json`:

```bash
agent-skills publish
```

This rewrites the index file in place — commit it.

---

## Step 4 — Resolve locally (no agent needed)

Test that your `command_template` produces the right shell command before any agent sees it:

```bash
agent-skills resolve skills/gh-pr-summary/SKILL.md \
  --args '{"pr_url": "https://github.com/cli/cli/pull/9000"}'
```

Output:

```
gh pr view 'https://github.com/cli/cli/pull/9000' --json number,title,author,state,files,comments | jq
```

The arg got single-quoted automatically (SPEC §2.6 — this is the privacy boundary; see below). If the output looks wrong, fix `command_template` and re-run.

You can also actually execute it (uses your shell, prints stdout/stderr, captures audit log):

```bash
agent-skills exec skills/gh-pr-summary/SKILL.md \
  --args '{"pr_url": "https://github.com/cli/cli/pull/9000"}'
```

This requires `gh` installed and authenticated; it's how agents will actually invoke the skill.

---

## Step 5 — Publish to GitHub

```bash
git init
git add .
git commit -m "Initial pack: gh-pr-summary"
gh repo create my-skill-pack --public --source=. --push
git tag v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Optional but recommended: create a release on GitHub for the tag. The release page is what humans see when they evaluate your pack.

```bash
gh release create v0.1.0 --generate-notes
```

That's it on the publishing side. Your pack is live at `github.com/<you>/my-skill-pack@v0.1.0`.

---

## Step 6 — How agents find it

A consumer (someone running an agent) subscribes to your pack:

```bash
agent-skills sync github.com/<you>/my-skill-pack@v0.1.0
```

Then queries it in natural language:

```bash
agent-skills query "summarize a github PR"
```

Output:

```
1. gh-pr-summary  (score: 0.78, source: github.com/<you>/my-skill-pack@<sha>)
   Fetches a GitHub pull request and emits a concise summary (title, author, ...
```

The agent's runtime calls `query` under the hood, picks the top hit, and (if the user/policy approves) calls `exec` with the chosen args.

---

## The privacy invariant (P1) — why your skill is safer than a tool-call

The CLI substitutes args **at shell exec time, not at LLM-prompt time**. That means:

✅ **Safe:** referencing `${GITHUB_TOKEN}` in `command_template`. The token is read from the *runner's* environment when the shell runs the command. The LLM never sees it.

❌ **Not safe:** prompting the LLM with the token's value and asking it to construct a `gh` call. That's the classic tool-calling failure mode.

Concretely, this `command_template` is fine even though it references a secret:

```yaml
command_template: gh pr view {pr_url} --json title,body  # gh reads GITHUB_TOKEN from env
```

And you can be more explicit about env requirements:

```yaml
applicable_when:
  env_present: [GITHUB_TOKEN]   # bank refuses to expose this skill if the env var isn't set
command_template: |
  curl -H "Authorization: Bearer $GITHUB_TOKEN" \
       https://api.github.com/repos/{repo}/pulls/{number}
```

The bank substitutes `{repo}` and `{number}` (with safe quoting). The shell substitutes `$GITHUB_TOKEN`. The LLM sees neither secret nor the substituted shell command — just *that the skill exists and is applicable*.

This is the property that makes agent-skills different from MCP tool-calls: **the trust boundary is the shell, not the model.**

---

## Common gotchas

### "My skill doesn't show up in `query` results"
- Check `applicable_when.commands_available` — does the bank's host have those binaries? Run `agent-skills query <intent> --include-filtered-out` to see why your skill was filtered.
- Check `description` — the embedding is computed over the whole frontmatter, but `description` is weighted heavily. A description that doesn't use the user's vocabulary will rank low.

### "Validation passes but the resolve output looks wrong"
- `command_template` uses `{name}` interpolation; `${VAR}` is shell expansion (preserved as-is). Don't mix them up.
- Multi-word args get single-quoted. If you need different quoting (e.g., a path with apostrophes), see SPEC §2.6.

### "I want to update my pack — what's the consumer flow?"
- Tag a new version (`v0.2.0`).
- Consumers run `agent-skills update` (re-resolves all subscribed refs; re-syncs only what moved).
- Old SHAs stay on disk in the bank's content-addressable cache until GC; rollback is `agent-skills sync <repo>@<old-tag>`.

### "Should I tag-sign my releases?"
- Recommended for any pack consumed in production. `git tag -s v0.1.0` (GPG) or with `gpg.format ssh` (SSH key on your GitHub account).
- Banks at Level 3a (GitHub-verified) automatically pick up the signature status — no consumer action needed beyond `--verify-signature` on `sync` to *enforce*.
- For high-trust deployments, see [SPEC §5](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md#5-provenance-and-trust) for the trust-level matrix.

---

## Anti-patterns

- **Don't put a long prose description in `description`.** Keep it focused on *what task this solves*. Long Markdown belongs in the body of `SKILL.md` (the part *after* the frontmatter); banks include it in the embedding but agents don't get it as a tool definition.
- **Don't pre-compute outputs.** A skill is an executable *shape*, not a snapshot. If your tool's output changes per-invocation (PR comments, repo state), that's correct — the agent calls the skill at retrieval time and gets fresh data.
- **Don't ship secrets in `SKILL.md`.** Use `applicable_when.env_present` to declare what env vars the runner needs. The values stay in the consumer's env, never in your repo.
- **Don't have one giant skill.** A skill is a *task*, not a tool. `gh-pr-summary` is one skill; `gh-issue-summary` is another; `gh-merge-pr` is another. The retrieval system is what stitches them together.

---

## Where to ask questions

- File issues / discussions on the pack repo for skill-content questions
- File on [`agent-skills`](https://github.com/MauricioPerera/agent-skills/issues) for spec questions
- File on [`agent-skills-cli`](https://github.com/MauricioPerera/agent-skills-cli/issues) for tooling/CLI questions

If you're publishing something interesting, open a discussion thread — others will want to see how you solved it.
