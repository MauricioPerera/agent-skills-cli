# `agent-skills-cli`

> Reference CLI + library for the [agent-skills specification](https://github.com/MauricioPerera/agent-skills).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/MauricioPerera/agent-skills-cli?label=release)](https://github.com/MauricioPerera/agent-skills-cli/releases)
[![ci](https://github.com/MauricioPerera/agent-skills-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/MauricioPerera/agent-skills-cli/actions/workflows/ci.yml)
[![e2e](https://github.com/MauricioPerera/agent-skills-cli/actions/workflows/e2e.yml/badge.svg)](https://github.com/MauricioPerera/agent-skills-cli/actions/workflows/e2e.yml)

## What this is

The agent-skills spec defines a **format** (`SKILL.md` with YAML frontmatter) and a **protocol** (sync/query/exec via skill banks). This CLI is the **first reference implementation** of the local-only operations: validate a SKILL.md against the spec, and resolve a `command_template` with given arg values.

The full skill-bank pipeline (sync, embed, query, audit) is delegated to runtimes like [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data); this CLI focuses on the **author's tools**: "is my SKILL.md correct?" and "what command does it produce for these args?"

## Status

**v0.12.0** — per-tenant audit scoping. Multi-tenant skill-bank deployments (shared CI bots, team setups, multi-user agents) get isolation: Alice's heavy use of `base64-encode` no longer bleeds into Bob's intent-conditional rerank.

```bash
$ agent-skills exec base64-encode --args '{"value":"x"}' --tenant alice  # records tenant
$ agent-skills query "encode something" --tenant bob                     # only Bob's history boosts
```

The `--tenant` flag (validated as `^[a-zA-Z0-9._-]{1,64}$`) is supported on `exec`, `query`, and `bench`. Per SPEC §4.5.1: when set, the audit entry records the tenant; intent-conditional rerank filters past audits by tenant before computing the boost. When unset (the default for single-user deployments), behaviour is identical to v0.11.

Backwards-compatible: existing audit logs (no `tenant` field) work unchanged. The field is optional and additive.

---

**v0.11.0+ + spec v0.2** — the spec is specified, not just documented: a [510-line Python proof-of-concept](https://github.com/MauricioPerera/agent-skills-py-proof) reproduces this CLI's retrieval behaviour bit-for-bit (34/35 top-1, 35/35 top-3, mean margin +0.175 — identical to 4 decimals on the canonical benchmark). The cross-implementation parity is continuously validated by [`e2e.yml`](https://github.com/MauricioPerera/agent-skills-cli/actions/workflows/e2e.yml) on every push and weekly cron.

---

**v0.11.0** — `update` command. Closes the obvious UX gap left by `sync`: how do you refresh installed packs?

```bash
$ agent-skills update                    # check every subscription
Update 2 subscription(s)

  ↑ github.com/me/pack-a@main
      a1b2c3d4e5f6 → fedcba098765
      + new-skill
      ↑ http-get: 1.0.0 → 1.1.0
      - obsolete-skill
      gc: removed 7 orphaned file(s)

  · github.com/me/pack-b@v2.0.0
      9876abcd1234 (no change)

summary: 1 changed, 1 unchanged
```

`update` re-resolves each subscribed ref against the host's API, re-syncs only when the SHA actually moved, **garbage-collects the orphan files** that older `sync` calls left behind on each pack, and reports a per-skill diff (added / removed / version-bumped). It inherits the subscription's `verify_signature` setting, so a moving tag that becomes unsigned aborts the update before any ingestion happens.

`--dry-run` resolves new SHAs and reports what would change without writing anything.

**v0.10.0** — signed-tag verification at sync time. Closes the SECURITY.md threat model item that's been documented since v0.1: an attacker who compromises an upstream account or the host's tag-resolution path can't move a `v1.0.0` tag to point at malicious code without also forging a GPG-verified signature on the tag.

Two-tier enforcement:

- **Always observe**: every sync calls GitHub's verification API and records the result in `provenance.signature_status` (one of `valid` / `invalid` / `unsigned` / `unverified`). Free, zero opt-in.
- **Optionally enforce**: pass `--verify-signature` (or set `verify_signature: true` on the subscription) and the sync **aborts** when status isn't `valid`.

```bash
$ agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0 --verify-signature
signature verification failed for github.com/MauricioPerera/agent-skills-pack@v1.0.0:
status=unsigned (tagger: MauricioPerera <mauricio.perera@gmail.com>, reason: unsigned).
Pass without --verify-signature to ingest unverified, or work with the publisher to
sign their tag with 'git tag -s' and re-tag.
```

The author side already creates signed tags via `agent-skills publish --sign` (v0.8.0). Now the consumer side can require them.

**v0.9.0** — `init` command. Scaffolds a single skill or an entire skill pack from embedded templates. The output is publish-ready on the first run:

```bash
$ agent-skills init my-pack --pack --author "Alice"
init pack: my-pack

Wrote 5 file(s):
  + skills/hello-world/SKILL.md
  + llms.txt
  + README.md
  + .gitignore
  + .github/workflows/validate.yml

$ cd my-pack && agent-skills publish --check-only
Publish 1 skill(s) from .
  · hello-world                   1.0.0
summary: 0 added, 0 updated, 1 unchanged    # ← clean validation, first try
```

Two modes:
- `init <name>` — adds `skills/<name>/SKILL.md` to an existing pack (with all spec fields commented for discoverability).
- `init <name> --pack` — scaffolds a brand-new pack with `skills/`, `llms.txt`, `README.md`, `.gitignore`, and a CI workflow.

The scaffolded `SKILL.md` always validates against the spec on the first run, so `agent-skills publish --check-only` is green immediately. THEN the author edits.

**v0.8.0** — `publish` command for skill-pack authors. Closes the author side of the loop:

```bash
$ cd my-skill-pack/    # has skills/foo/SKILL.md, skills/bar/SKILL.md
$ agent-skills publish --check-only
Publish 2 skill(s) from .

  · foo                          1.0.0
  · bar                          1.0.0

summary: 0 added, 0 updated, 2 unchanged
✓ skills-index.json already up-to-date
```

What it does: scans `skills/`, validates each `SKILL.md` against the spec, generates or updates `skills-index.json` (preserving hand-crafted summaries and any curated skill ordering across re-publishes), optionally creates a git tag (`--tag v1.0.1`, `--sign` for signed). Idempotent: running twice on an unchanged tree is a byte-identical no-op.

**v0.7.0** — `bench` subcommand for reproducible retrieval evaluation. Anyone can verify the empirical claims in BENCHMARK.md against their own bank, with their own provider, and their own ground truth file:

```bash
$ agent-skills bench bench-truth.jsonl
Bench against 35 queries
  truth: bench-truth.jsonl
  model: ollama:embeddinggemma | rerank=intent-conditional | filter=on

  top-1:  34/35 (97.1%)
  top-3:  35/35 (100.0%)
  top-5:  35/35 (100.0%)
  mean top-1 score:  0.551
  mean margin (top-1 → top-2):  +0.175
  elapsed: 42306ms

Failures (1):
  ✗ "read what's at this https url"
      expected: http-get (rank 2, score 0.450)
      got:      read-file (score 0.464)
```

Use `--json` for CI integration; non-zero exit when any query fails (so a regression breaks the build).

**v0.6.0** — multi-provider embeddings. The CLI works against:

- **Cloudflare Workers AI** (`bge-base-en-v1.5` / `bge-large` / `bge-m3` / `embeddinggemma`).
- **Ollama** (local, zero credentials, zero network egress — `nomic-embed-text` by default).
- **OpenAI / OpenAI-compatible** (`text-embedding-3-small/large` + Together / Anyscale / Mistral / vLLM / infinity / TEI any server speaking the same `/v1/embeddings` shape).

Auto-detected from your environment (or set `EMBEDDING_PROVIDER` explicitly). Same loop:

```
sync   → pulls + embeds + indexes a skill pack from any git source
query  → finds the right skill from intent (--rerank-mode intent-conditional|global|none)
exec   → runs the resolved command via bash + appends an audit entry
audit  → inspects the local audit log
```

Plus local-only commands (`validate`, `resolve`) and bank management (`list`, `reset`).

**Empirical claim updated** (v0.5.0, live `@cf/baai/bge-base-en-v1.5`, 35 paraphrases × 7 skills, 50 concentrated past uses on `base64-encode`):

| Strategy | Top-1 |
|---|---:|
| Cosine baseline | 34/35 (97.1 %) |
| Global rerank (the v0.4.0 stress failure) | **12/35 (34.3 %) ⚠️** |
| **Intent-conditional sim≥0.7 (v0.5.0 default)** | **35/35 (100 %) ✓** |

The same audit log that destroys global-mode rerank (50 uses of one skill → it wins almost every query) is what makes intent-conditional rerank exceed the cosine baseline (it correctly resolves the "Basic Auth credential" ambiguity using the relevant past intents while ignoring the rest).

Full methodology, all 5 strategies compared, failure breakdowns, and operator tuning guidance: [BENCHMARK.md](./BENCHMARK.md).

> **Earlier validation still holds** (35 paraphrases × 3 embedding models = 105 query evaluations on the public skill pack, no rerank): top-1 97–100 %, top-3 100 % across all 3 models.

## Install

```bash
# Global CLI — exposes `agent-skills` on your PATH
npm install -g @rckflr/agent-skills-cli

# Or as a project library
npm install @rckflr/agent-skills-cli
```

> **Pre-1.0 stability note.** API and CLI surface are evolving until v1.0. Pin a specific version in CI / production. The `@rckflr/` scope is the canonical home until v1.0 — the unscoped `agent-skills-cli` name on npm is held by an unrelated project.

### Or install from a GitHub release tag

For air-gapped environments, or to track main directly:

```bash
git clone --depth 1 --branch v0.18.1 https://github.com/MauricioPerera/agent-skills-cli
cd agent-skills-cli
npm install
npm run build
npm link            # exposes `agent-skills` on your PATH
```

Or pin a specific commit in your `package.json`:

```json
"@rckflr/agent-skills-cli": "github:MauricioPerera/agent-skills-cli#v0.18.1"
```

### Publishing your own skills?

Walk-through with concrete example: **[PUBLISHING.md](./PUBLISHING.md)** — scaffold to public release in 20–30 minutes, including the privacy invariant.

### Library API stability

The library exports are tiered (stable / experimental / internal) with explicit breaking-change rules per tier. See **[STABILITY.md](./STABILITY.md)** before depending on programmatic exports in production.

### Upgrading between major versions

See **[MIGRATION.md](./MIGRATION.md)** for per-major-version migration notes. Minor-version upgrades within a major never require migration.

## End-to-end demo

Pick **one** of the three embedding providers below. Everything else is identical.

### Option A — Local with Ollama (zero credentials, zero network)

```bash
# 1. Pull an embedding model into Ollama (one-time, ~270 MB for nomic-embed-text)
ollama pull nomic-embed-text

# 2. Tell the CLI to use it (defaults to localhost:11434, model nomic-embed-text)
export EMBEDDING_PROVIDER=ollama
```

### Option B — Cloudflare Workers AI (free tier available)

```bash
# 1. Get credentials from https://dash.cloudflare.com/profile/api-tokens
#    (token needs "Workers AI" permission)
export CF_ACCOUNT_ID=<32-hex-account-id>
export CF_API_TOKEN=<your-token>
```

### Option C — OpenAI (or any OpenAI-compatible server)

```bash
export OPENAI_API_KEY=sk-...
# Optional: point at a compatible server (Together / Mistral / vLLM / TEI / infinity / …)
# export OPENAI_BASE_URL=https://api.together.xyz/v1
```

### Same flow regardless of provider

```bash
# 1. Sync a real skill pack (7 production-ready skills)
$ agent-skills sync github.com/MauricioPerera/agent-skills-pack@v1.0.0
Synced github.com/MauricioPerera/agent-skills-pack@v1.0.0
  ref: v1.0.0 → 4f5a2c7e9b1d3f8a6c0e7d2b5f9a1c4e8d3b6a72
  total: 7 | synced: 7 | invalid: 0 | errored: 0

  ✓ http-get
  ✓ http-post-json
  ✓ github-issue-create
  ✓ ripgrep-search
  ✓ read-file
  ✓ json-query
  ✓ base64-encode

# 3. Query by intent — agent finds the right skill on demand
$ agent-skills query "I need to fetch the contents of a webpage"
Top 5 skills for: "I need to fetch the contents of a webpage"
Embedding model: cloudflare:@cf/baai/bge-base-en-v1.5

1. [0.847] github.com/MauricioPerera/agent-skills-pack@.../http-get
   Title: HTTP GET request
   Use when: the user wants to fetch the contents of a URL...

2. [0.612] github.com/MauricioPerera/agent-skills-pack@.../http-post-json
   ...

# 4. Resolve the chosen skill (substitute args, NOT execute)
$ agent-skills resolve <(curl -fsSL https://cdn.jsdelivr.net/gh/MauricioPerera/agent-skills-pack@v1.0.0/skills/http-get/SKILL.md) --args '{"url":"https://example.com","timeout":15}'
curl -fsSL --max-time 15 'https://example.com'

# 5. Execute the resolved command (only if you trust the skill)
$ agent-skills resolve ... --args '...' | bash
```

The agent's loop is: **embed intent → vector search → fetch metadata → resolve → execute**. With this CLI, every step is a single command.

## Commands

### `agent-skills validate <file>`

Validate a SKILL.md against:

1. **JSON Schema** for the frontmatter shape (Draft 2020-12, bundled).
2. **Spec constraints** beyond the schema:
   - Placeholders MUST be in argument position (no `{x}` inside literal `"..."` or `'...'`) — SPEC §2.6.
   - `unquoted: true` args MUST declare a strict `pattern` rejecting shell metacharacters.
   - Every `{placeholder}` in `command_template` MUST have a corresponding `args` entry.

```bash
$ agent-skills validate skills/charge-customer/SKILL.md
✓ skills/charge-customer/SKILL.md is conformant

$ agent-skills validate broken-skill.md
✗ broken-skill.md has 2 error(s):
  args.x: unquoted args MUST declare a pattern (SPEC §2.6)
  command_template: placeholder '{undefined_arg}' has no corresponding entry in args
```

JSON output for tooling integration:

```bash
$ agent-skills validate broken-skill.md --json
{"file":"broken-skill.md","valid":false,"errors":[...]}
```

Exit codes:
- `0` — conformant
- `5` — non-conformant (validation error)
- `2` — usage error
- `3` — file not found

### `agent-skills resolve <file> --args '<json>'`

Substitute placeholders against a JSON arg map and print the resolved bash command. Does **NOT** execute.

```bash
$ agent-skills resolve skills/charge-customer/SKILL.md \
    --args '{"amount":1000,"currency":"usd","customer_id":"cus_X","description":"test"}'

curl -fsSL --request POST https://api.stripe.com/v1/charges --user $STRIPE_SECRET_KEY: --data amount=1000 --data currency='usd' --data customer='cus_X' --data description='test'
```

Note: the `$STRIPE_SECRET_KEY` reference in the template is **NOT** substituted by the CLI — it remains a literal shell variable that bash will expand at exec time. This is the **credential isolation invariant** (SPEC §8 P1): secrets never enter the LLM context.

JSON output (with audit trace):

```bash
$ agent-skills resolve skills/charge-customer/SKILL.md \
    --args '{"amount":1000,"currency":"usd","customer_id":"cus_X","description":"test"}' \
    --json
{
  "file": "skills/charge-customer/SKILL.md",
  "command": "curl -fsSL ... --data amount=1000 ...",
  "trace": [
    {"name":"amount","type":"integer","rendered":"1000"},
    {"name":"currency","type":"string","rendered":"'usd'"},
    {"name":"customer_id","type":"string","rendered":"'cus_X'"},
    {"name":"description","type":"string","rendered":"'test'"}
  ]
}
```

`resolve` validates the skill before substituting (same rules as `validate`). Use `--skip-validation` to bypass for testing non-conformant skills (NOT recommended).

Pipe to bash to execute:

```bash
agent-skills resolve skills/charge-customer/SKILL.md --args '{"amount":1000,...}' | bash
```

(With `$STRIPE_SECRET_KEY` set in your environment.)

### `agent-skills exec <skill> --args '<json>'` *(v0.3.0+)*

Resolve and **execute** a skill from your local bank in one step. Spawns `bash -c <resolved-command>`, captures stdout/stderr/exit-code, appends an audit entry. Inherits the parent process's env (so `$STRIPE_SECRET_KEY`, `$GH_TOKEN`, etc. work).

```bash
# Identify a skill by short id (must be unique across the bank) or full identity
$ agent-skills exec base64-encode --args '{"value":"hello world"}'
aGVsbG8gd29ybGQ=

# Or:
$ agent-skills exec github.com/MauricioPerera/agent-skills-pack@<sha>/http-get \
    --args '{"url":"https://example.com","timeout":10}'
```

Flags:

- `--dry-run` — resolve + validate, print the command, but **do not execute**.
- `--timeout-sec N` — hard timeout. Default 60s. After it fires, SIGTERM, then 2s grace, then SIGKILL, then forced resolution at +4s if the proc still hasn't reaped (Windows msys / Git Bash safety net).
- `--no-audit` — skip the audit log entry.
- `--intent "<text>"` — record the original user intent in the audit entry (useful when called from a query→exec pipeline).
- `--json` — return the full result as JSON (`{skill_identity, command, exit_code, stdout, stderr, elapsed_ms, timed_out, dry_run}`).

The CLI's exit code matches the executed command's exit code (the agent can dispatch on `$?` directly).

**Sensitive args are redacted in the audit log.** A skill author marks an arg with `sensitive: true` in its `args` schema; the CLI substitutes `"<redacted>"` in the audit JSONL even though the value still flows to the bash subprocess at exec time.

### `agent-skills update [<source>] [--dry-run]` *(v0.11.0+)*

Refresh subscribed packs from upstream. Re-resolves each subscribed ref against the host's API; re-syncs only the ones whose SHA has actually moved; garbage-collects the orphan files that older syncs left behind; reports a per-skill diff.

```bash
# Refresh all subscriptions
$ agent-skills update
Update 2 subscription(s)

  ↑ github.com/me/pack-a@main
      a1b2c3d4e5f6 → fedcba098765
      + new-skill
      ↑ http-get: 1.0.0 → 1.1.0
      - obsolete-skill
      gc: removed 7 orphaned file(s)

  · github.com/me/pack-b@v2.0.0
      9876abcd1234 (no change)

summary: 1 changed, 1 unchanged

# Refresh a specific subscription
$ agent-skills update github.com/me/pack-a@main

# Preview what would change without writing
$ agent-skills update --dry-run
```

**Behaviour**:

- **Idempotent on a stable ref**. Re-running on a `@v1.0.0` pinned tag is a no-op — no embedding API calls, no disk writes, no subscription updates.
- **GC built in**. `sync <repo>@<new-ref>` accumulates orphan files at every SHA it ever resolved. `update` removes everything from this source whose SHA isn't the current one. (Sync alone doesn't — that's by design; sync is for first-install, update is for refresh.)
- **Inherits signature enforcement** from the subscription. If the original sync used `--verify-signature`, that flag is persisted (`verify_signature: true` in the subscription record) and `update` reuses it — so a moving tag that becomes unsigned aborts the update before any ingestion.
- **--dry-run** resolves new SHAs and reports what would change without writing anything.
- **JSON output** (`--json`) emits the full `UpdateResult` struct — every per-subscription delta with `added`/`removed`/`updated` arrays for CI integration.

Exit code: `0` on success (even on no-op), `1` if any subscription's update failed (e.g., resolve error, signature enforcement abort).

### `agent-skills audit [--limit N] [--skill <id>]`

Inspect the local audit log (append-only JSONL at `<bank>/audit.jsonl`).

```bash
$ agent-skills audit --limit 5
2026-04-28T06:18:02.048Z  ✓  github.com/MauricioPerera/agent-skills-pack@.../read-file  (124ms)
2026-04-28T06:18:00.444Z  ✓  github.com/MauricioPerera/agent-skills-pack@.../base64-encode  (232ms)
    intent: encode hello as base64
```

Filter by skill identity to see one tool's usage history:

```bash
$ agent-skills audit --skill github.com/.../base64-encode --json | jq '.[] | {timestamp, exit_code, args}'
```

The audit log is **local only** (per [SPEC §8 P3](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md#8-privacy-invariants)) — it never leaves your machine.

### `agent-skills bench <truth-file>` *(v0.7.0+)*

Measure top-K retrieval accuracy against a ground-truth file of `(intent, expected_skill_id)` pairs. Same code path as `query`, so the numbers match what the agent would actually see.

**Truth file format** (auto-detected by first non-whitespace char):

```jsonl
# JSONL — one entry per line, blank lines and # comments OK
{"intent": "fetch the contents of a URL", "expected": "http-get"}
{"intent": "encode a string as base64", "expected": "base64-encode"}
```

```json
[
  { "intent": "fetch the contents of a URL", "expected": "http-get" },
  { "intent": "encode a string as base64", "expected": "base64-encode" }
]
```

`expected` is the skill's short id (the frontmatter `id` field), not the full identity — so truth files stay portable across skill-pack revisions. The bench fails fast if any `expected` doesn't resolve to exactly one installed skill.

**Output**:

```bash
$ agent-skills bench bench-truth.jsonl
Bench against 35 queries
  truth: bench-truth.jsonl
  model: ollama:embeddinggemma | rerank=intent-conditional | filter=on

  top-1:  34/35 (97.1%)
  top-3:  35/35 (100.0%)
  top-5:  35/35 (100.0%)
  mean top-1 score:  0.551
  mean margin (top-1 → top-2):  +0.175
  elapsed: 42306ms

Failures (1):
  ✗ "read what's at this https url"
      expected: http-get (rank 2, score 0.450)
      got:      read-file (score 0.464)
```

**Flags**:
- `--k N` — report top-K (default 5). top-1 and top-3 always shown.
- `--rerank-mode <mode>` — same options as `query`: `intent-conditional` (default) | `global` | `none`.
- `--no-rerank` — shortcut for `--rerank-mode none`.
- `--no-filter` — disable applicable_when filtering during the bench.
- `--embedding-provider <p>` — override env auto-detect.
- `--json` — emit a machine-readable result (every per-query row + summary).

**CI integration**: the CLI exits non-zero when `failures.length > 0`, so a regression breaks the build.

```bash
agent-skills bench bench-truth.jsonl --json > result.json
[ "$(jq '.top1' result.json)" -ge 35 ] || exit 1
```

The public skill pack ships its own truth file at [`agent-skills-pack/bench-truth.jsonl`](https://github.com/MauricioPerera/agent-skills-pack/blob/main/bench-truth.jsonl) — 35 paraphrases × 7 skills.

### `agent-skills init <name> [--pack] [--in <dir>]` *(v0.9.0+)*

Scaffolds a new skill (single mode) or a complete skill pack (`--pack` mode) from embedded templates. The generated `SKILL.md` is **publish-ready on the first run** — `agent-skills publish --check-only` is green immediately. Then the author edits.

**Single-skill mode** (use inside an existing pack):

```bash
$ cd my-skill-pack/
$ agent-skills init scrape-website
init skill: my-skill-pack

Wrote 1 file(s):
  + skills/scrape-website/SKILL.md

Next:
  edit skills/scrape-website/SKILL.md
  agent-skills publish --check-only   # validate + refresh skills-index.json
```

**Pack mode** (start a brand-new skill pack):

```bash
$ agent-skills init my-pack --pack --author "Alice"
init pack: my-pack

Wrote 5 file(s):
  + skills/hello-world/SKILL.md
  + llms.txt
  + README.md
  + .gitignore
  + .github/workflows/validate.yml

Next:
  cd my-pack
  agent-skills publish --check-only   # should be a clean validation
  git init && git add . && git commit -m "Initial pack"
  # Then add the GitHub topic 'agent-skills' and publish a tagged release.
```

The scaffolded `hello-world` skill is a working `echo` wrapper with a strict pattern arg. It's intentionally minimal so the author has the smallest possible diff to make it real.

**Discoverability surface**: the generated `SKILL.md` includes **every optional frontmatter field commented out** with a one-line explanation per field — `applicable_when`, `network`, `examples`, `tags`, `category`, `idempotent`, `chain`. Authors discover the spec by editing the scaffold rather than reading SPEC.md.

**Flags**:
- `--pack` — scaffold a whole pack at `./<name>/` instead of a single skill at `./skills/<name>/`.
- `--in <dir>` — root directory. Default: `.` (cwd).
- `--author <name>` — inject as `author.name` (single mode) and the README/llms.txt headers (pack mode).
- `--force` — overwrite existing files. Default: refuse.

Refusing to overwrite is **per-file**: re-running `init` on a partially-built pack fills in only the files that don't exist yet, leaving your edits alone.

### `agent-skills publish [<dir>]` *(v0.8.0+)*

Author-side command. Validates every `SKILL.md` under `<dir>/skills/`, generates or updates `<dir>/skills-index.json`, and optionally creates a signed git tag.

```bash
$ cd my-skill-pack/
$ agent-skills publish
Publish 7 skill(s) from .

  · http-get                     1.0.0
  · http-post-json               1.0.0
  + new-skill                    1.0.0   (added)
  ↑ ripgrep-search               2.0.0   (updated)
  · …

  Removed (in old index, not on disk):
    - obsolete-skill

summary: 1 added, 1 updated, 5 unchanged, 1 removed
✓ wrote skills-index.json
```

**Status glyphs**:
- `+` added (new on disk, not in old index)
- `↑` updated (version, url, or summary changed)
- `·` unchanged (matched the existing index byte-for-byte)
- `✗` invalid (validation failed — index NOT written)
- `!` error (parse error or unreadable file)

**Flags**:
- `--check-only` — validate but don't write or tag. CI-friendly.
- `--tag <version>` — create git tag at HEAD (e.g., `v1.0.1`).
- `--sign` — signed tag (`git tag -s`). Requires GPG configured.
- `--repo <repo>` — first-publish only: set `default_source.repo` (e.g., `github.com/me/pack`).
- `--branch <name>` — first-publish only: set default branch.
- `--ref <ref>` — embed this ref in resolved skill URLs (e.g., `v1.0.0`).
- `--json` — machine-readable result.

**Behaviour**:
- **Hand-crafted summaries preserved** across re-publishes. New skills get an auto-generated summary from `description`; existing skills keep whatever summary is in the index.
- **Curated skill ordering preserved**. `publish` walks the existing index's order first, appending only newly-discovered skills (alphabetically among themselves) at the end.
- **Idempotent**. Running `publish` twice on an unchanged tree is a byte-identical no-op — no timestamps, no reordering. Safe in pre-commit hooks.
- **Fail-fast**. If any `SKILL.md` is invalid, the index is NOT written and the command exits with code 5.

**CI integration** (e.g., GitHub Actions):

```yaml
- name: Validate skill pack
  run: |
    npx --yes agent-skills-cli@latest publish --check-only --json > pub.json
    [ "$(jq '.invalid + .errored' pub.json)" -eq 0 ] || exit 1
```

## Library usage

The CLI is also a library, importable in your own TypeScript:

```typescript
import {
  parseSkillSource,
  validateSkill,
  resolveCommand,
  parseIdentity,
  deriveUrls,
} from "agent-skills-cli";

// Parse + validate
const skill = parseSkillSource(fileContent);
const validation = validateSkill(skill.frontmatter);
if (!validation.valid) {
  console.error(validation.errors);
  process.exit(5);
}

// Resolve a command
const result = resolveCommand(skill.frontmatter, { amount: 1000, currency: "usd" });
console.log(result.command);

// Parse a skill identity
const id = parseIdentity("github.com/stripe/agent-skills@a1b2c3d4...abc/charge-customer");
const urls = deriveUrls(id);
// → ["https://cdn.jsdelivr.net/gh/stripe/agent-skills@.../charge-customer/SKILL.md", ...]
```

Full type definitions are exported. See `src/types.ts`.

## Roadmap

| Version | Status | Scope |
|---|---|---|
| v0.2.0-alpha | shipped | `validate` + `resolve` (local-only) + library API |
| v0.2.0 | shipped | + `sync` + `query` + `list` + `reset`; Cloudflare Workers AI embeddings |
| v0.3.0 | shipped | + `exec` (bash subprocess + 3-stage kill ladder + sensitive-arg redaction) + `audit` (append-only JSONL log); closes agent loop end-to-end |
| v0.4.0 | shipped | + audit-based rerank (`α·log(1+usage)` + recency); applicable_when host detection; 5-strategy benchmark exposing global-rerank failure mode |
| v0.5.0 | shipped | + intent-conditional rerank as default (`IntentEmbeddingCache` + sim≥0.7 filter); fixes the 50-use stress failure with **100 % top-1** on live Workers AI |
| v0.6.0 | shipped | + Ollama (local, zero-credential) + OpenAI / OpenAI-compatible (Together / vLLM / TEI / infinity / …) embedding providers; auto-detect from env or `EMBEDDING_PROVIDER` flag |
| v0.6.1 | shipped | + 4 code-review patches (docstring, pure-Node PATH scan, ENOENT discrimination, bounded-concurrency sync) |
| v0.7.0 | shipped | + `bench` subcommand: reproducible top-K accuracy against a JSONL/JSON-array truth file. CI integration via JSON output + non-zero exit on any failure |
| v0.8.0 | shipped | + `publish` command: validate skills/, generate skills-index.json (preserves hand-crafted summaries + curated ordering), optionally git-tag |
| v0.9.0 | shipped | + `init` command: scaffold a single skill or full pack from embedded templates. Output validates against the spec on first run |
| v0.10.0 | shipped | + signed-tag verification at sync time. Closes the SECURITY.md tag-tampering threat model |
| v0.11.0 | shipped | + `update` command: re-resolve subscribed refs, re-sync only on movement, GC orphan files from old SHAs, per-skill diff |
| v0.12.0 | shipped | + per-tenant audit scoping (`--tenant <id>` on exec/query/bench); intent-conditional rerank filters by tenant; SPEC §4.5.1 |
| v0.13.0 | shipped | Cleanup + correctness: listSkills caching (perf), remove deprecated `rerank_applied` field, fix update.ts GC for multi-subscription edge case |
| v0.13.1 | shipped | + listAudit caching (closes the last perf debt from the post-v0.11 code review). 363/363 tests; 8/10 review issues fixed |
| v0.13.2 | shipped | Docs alignment patch: stale install/version refs across READMEs, init scaffolded CI workflow now pins v0.13.1, BENCHMARK.md updated. Plus a hotfix for a CI type-check break introduced in v0.13.1 |
| v0.13.3 | shipped | + `gc_protected` counter in update results (visibility into multi-sub GC); narrowed `Subscription.source_type` from `"git" \| "url"` to `"git"`. 10/10 review issues fixed |
| v0.14.0 | shipped | + Sigstore signature **detection** (structural via PEM header — `gpg` vs `sigstore` / `gitsign`). Full Rekor inclusion-proof verification (Level 4 enforcement) queued. Cross-impl parity (TS + Python) maintained in CI |
| v0.15.0 | shipped | + SSH-tag detection (`-----BEGIN SSH SIGNATURE-----` → `"ssh"`) — fixes a v0.14 oversight. Spec patch v0.3.2: documents the **Sigstore-on-host trap** |
| v0.16.0 | shipped | + Sigstore identity extraction: hand-rolled CMS/ASN.1 walker pulls the OIDC subject from the Fulcio cert's SAN and the issuer from extension `1.3.6.1.4.1.57264.1.1` (`/.1.8`). Surfaced as `provenance.signature_identity = { subject, subject_type, issuer }`. Zero new deps. Cross-impl parity validated against the real `sigstore/gitsign@v0.14.0` payload. Spec patch v0.3.3 |
| v0.17.0 | shipped | + Rekor entry parsing + public-instance pinning + lookup by UUID (`parseRekorEntry`, `fetchRekorEntry`, `RekorEntry` types). Real fixture committed for offline testing. Spec patch v0.4.0: formalizes the Level 4 verification *contract* (§5.4) — what banks must do, not how |
| v0.17.1 | shipped | + `computeGitsignRekorLookupHash` (CMS SignerInfo.SignedAttrs marshaled-for-verification per RFC 5652 §5.4 / gitsign source) + `findRekorEntryByHash` wrapper for Rekor's `index/retrieve`. Validated structurally via the messageDigest invariant. Spec v0.4.1 §5.4.2 step 3 codifies the framing math + the Rekor shard-rotation caveat |
| v0.18.0 | tagged | Intended npm publication; tagged but never published — package.json declared scope `@mauricioperera` which doesn't exist on npm under the available auth. v0.18.1 corrects to `@rckflr` |
| v0.18.1 | shipped | **First npm publication** as `@rckflr/agent-skills-cli`. Removes the install friction (`git clone && npm link` → `npm install -g`). Adoption blocker resolved without waiting for v1.0. No code changes vs v0.17.1 |
| v0.18.2 | tagged-only | + `release.yml` GitHub Action (OIDC trusted publisher + provenance attestation). Tag exists in git, workflow fired, but final `PUT` to npm registry returned 404 because npm-side Trusted Publisher config isn't in place yet. Kept as historical marker; provenance attestation for this attempt lives at [Rekor logIndex 1398755825](https://search.sigstore.dev/?logIndex=1398755825) |
| v0.18.3 | shipped | Published via granular-token-in-`~/.npmrc` (the standard pattern most solo npm publishers use; token rotates every 90 days). OIDC pipeline (`release.yml`) is in place but ran into an unresolved interaction between Trusted Publisher config and account-level 2FA-for-writes. Future releases retry OIDC first |
| v0.19.0 | shipped | API stability tiers formalized. New [`STABILITY.md`](./STABILITY.md) with the breaking-change policy per tier (stable / experimental / internal). Public exports in `src/index.ts` reorganized by tier with section headers. No API removals — purely annotations + policy |
| **v1.0.0** | **shipped** | **Stable API freeze.** [`MIGRATION.md`](./MIGRATION.md) added (zero breaking changes vs v0.19.0). Companion spec also bumps to v1.0. From here: STABLE exports protected by semver + 6-month deprecation window before any removal. ANN/IVF backend explicitly NOT shipped — empirical bench in [`BENCHMARK.md`](./BENCHMARK.md) confirms brute-force cosine handles 10K skills in ~20 ms, no realistic deployment needs more |
| post-1.0 | reactive | Item-by-item, driven by external pull: (a) Level 4 Rekor verification crypto if a Sigstore-signing publisher appears in the agent-skills ecosystem; (b) `Float32Array` cosine variant if a >50K-skill bank operator complains about latency; (c) ecosystem growth via second/third external pack publishers ([`OUTREACH.md`](./OUTREACH.md)). None blocked on the maintainer; all blocked on real demand |

## Continuous validation

Two workflows guard against regression:

- **`ci.yml`** — type-check, build, test on every push and PR. Fast (under 2 minutes), no external dependencies.
- **`e2e.yml`** — ecosystem coherence. Two jobs:
  1. **`cross-impl-parity`**: clones this CLI + [`agent-skills-py-proof`](https://github.com/MauricioPerera/agent-skills-py-proof) + [`agent-skills-pack`](https://github.com/MauricioPerera/agent-skills-pack), installs Ollama with `all-minilm`, runs `bench` against the same truth file with both implementations, **fails if their numerical results diverge**. Catches silent breakage when a sister repo evolves in a way that drifts retrieval.
  2. **`author-roundtrip`**: `init` a new pack, `publish --check-only` (must validate clean), `resolve` a scaffolded skill (must produce `echo 'hello world'`). Validates that the author tooling produces output the consumer tooling can ingest.

Runs on every push, on PR, and weekly via cron — the cron picks up sister-repo changes within 7 days even when this repo is quiet.

## Sister projects

- [`agent-skills`](https://github.com/MauricioPerera/agent-skills) — the **canonical specification** (v0.3.0).
- [`agent-skills-pack`](https://github.com/MauricioPerera/agent-skills-pack) — **example skill pack** with 7 production-ready skills + `bench-truth.jsonl`. Integration test corpus for this CLI.
- [`agent-skills-py-proof`](https://github.com/MauricioPerera/agent-skills-py-proof) — **510-line Python implementation** that produces bit-identical retrieval scores to this CLI. Cross-implementation validation of the spec.
- [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data) — alternative **storage runtime** providing `db` (document store) + `vec` (vector search) primitives.

## License

[MIT](./LICENSE)
