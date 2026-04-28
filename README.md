# `agent-skills-cli`

> Reference CLI + library for the [agent-skills specification](https://github.com/MauricioPerera/agent-skills).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/MauricioPerera/agent-skills-cli?label=release)](https://github.com/MauricioPerera/agent-skills-cli/releases)

## What this is

The agent-skills spec defines a **format** (`SKILL.md` with YAML frontmatter) and a **protocol** (sync/query/exec via skill banks). This CLI is the **first reference implementation** of the local-only operations: validate a SKILL.md against the spec, and resolve a `command_template` with given arg values.

The full skill-bank pipeline (sync, embed, query, audit) is delegated to runtimes like [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data); this CLI focuses on the **author's tools**: "is my SKILL.md correct?" and "what command does it produce for these args?"

## Status

**v0.5.0** — intent-conditional rerank as the new default. The CLI now:

```
sync   → pulls + embeds + indexes a skill pack from any git source
query  → finds the right skill from intent (NEW: --rerank-mode intent-conditional|global|none)
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

> **Pre-1.0: GitHub-only distribution.** This CLI is not published to npm yet — the `agent-skills-cli` name on the npm registry is held by an unrelated package. Install from the GitHub release until the spec and library API stabilize at v1.0.

```bash
# Clone a tagged release
git clone --depth 1 --branch v0.5.0 https://github.com/MauricioPerera/agent-skills-cli
cd agent-skills-cli
npm install
npm run build
npm link            # exposes `agent-skills` on your PATH

# Or run from the checkout without linking
node dist/cli.js validate skills/x/SKILL.md
```

To use the library programmatically without `npm link`, install the local checkout into your project:

```bash
npm install /path/to/agent-skills-cli
```

The CLI will be published to npm once the public API is frozen at v1.0. Until then, pin to a tagged commit in `package.json`:

```json
"agent-skills-cli": "github:MauricioPerera/agent-skills-cli#v0.5.0"
```

## End-to-end demo (with Cloudflare Workers AI)

```bash
# 1. Get Cloudflare credentials
#    https://dash.cloudflare.com/profile/api-tokens
#    Create a token with "Workers AI" permission.
export CF_ACCOUNT_ID=<32-hex-account-id>
export CF_API_TOKEN=<your-token>

# 2. Sync a real skill pack (7 production-ready skills)
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
| **v0.5.0** | **shipped** | + intent-conditional rerank as default (`IntentEmbeddingCache` + sim≥0.7 filter); fixes the 50-use stress failure with **100 % top-1** on live Workers AI; 192/192 tests |
| v0.6.0 | planned | `publish` (skill author tooling); multi-provider embeddings (Ollama, OpenAI, generic HTTP) |
| v0.7.0 | planned | Sigstore signature verification; signed-tag enforcement at sync time |
| v0.8.0 | planned | IVF-style ANN backend (swap-in for FileBank when catalog grows) |
| v1.0.0 | planned | Stable API + full SPEC v1.0 coverage; **first npm publication** (under a final, owned name — current `agent-skills-cli` on npm is an unrelated squat) |

## Sister projects

- [`agent-skills`](https://github.com/MauricioPerera/agent-skills) — the **canonical specification**. This CLI implements its v0.1 schema.
- [`agent-skills-pack`](https://github.com/MauricioPerera/agent-skills-pack) — **example skill pack** with 7 production-ready skills. Used as the integration test corpus for this CLI.
- [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data) — the **storage runtime** the future `sync`/`query`/`exec` commands will use. Provides `db` (document store) + `vec` (vector search) primitives.

## License

[MIT](./LICENSE)
