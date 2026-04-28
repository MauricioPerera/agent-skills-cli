# `agent-skills-cli`

> Reference CLI + library for the [agent-skills specification](https://github.com/MauricioPerera/agent-skills).

[![npm](https://img.shields.io/npm/v/agent-skills-cli.svg)](https://www.npmjs.com/package/agent-skills-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What this is

The agent-skills spec defines a **format** (`SKILL.md` with YAML frontmatter) and a **protocol** (sync/query/exec via skill banks). This CLI is the **first reference implementation** of the local-only operations: validate a SKILL.md against the spec, and resolve a `command_template` with given arg values.

The full skill-bank pipeline (sync, embed, query, audit) is delegated to runtimes like [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data); this CLI focuses on the **author's tools**: "is my SKILL.md correct?" and "what command does it produce for these args?"

## Status

**v0.2.0-alpha** — early reference. The library API and exit codes are stable enough to script against; expect minor iteration before v0.2.0 final.

## Install

```bash
npm i -g agent-skills-cli
# or, no install
npx agent-skills-cli validate skills/x/SKILL.md
```

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

| Version | Goal |
|---|---|
| **v0.2.0-alpha** *(current)* | `validate` + `resolve` commands; library API for parse / validate / substitute / identity. |
| v0.2.0 | Add `sync` command (Ollama embedding, just-bash-data integration). Conformance test suite. |
| v0.3.0 | Add `query` + `exec` commands (run a skill end-to-end against a populated bank). |
| v0.4.0 | Add `publish` command (validate + stamp + commit + tag). |
| v1.0.0 | Stable API. Full coverage of SPEC v1.0. |

## Sister projects

- [`agent-skills`](https://github.com/MauricioPerera/agent-skills) — the **canonical specification**. This CLI implements its v0.1 schema.
- [`agent-skills-pack`](https://github.com/MauricioPerera/agent-skills-pack) — **example skill pack** with 7 production-ready skills. Used as the integration test corpus for this CLI.
- [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data) — the **storage runtime** the future `sync`/`query`/`exec` commands will use. Provides `db` (document store) + `vec` (vector search) primitives.

## License

[MIT](./LICENSE)
