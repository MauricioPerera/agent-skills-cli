# Security Policy

This document covers **responsible vulnerability disclosure** for the `@rckflr/agent-skills-cli` package. For the broader threat model of the agent-skills design (privacy invariants, trust levels, Sigstore-on-host trap, etc.), see the spec's [SECURITY.md](https://github.com/MauricioPerera/agent-skills/blob/main/SECURITY.md).

---

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email: **mauricio.perera@gmail.com** with subject prefix `[security] @rckflr/agent-skills-cli` — or use [GitHub's private vulnerability reporting](https://github.com/MauricioPerera/agent-skills-cli/security/advisories/new) if you prefer that channel.

Include:

- A description of the vulnerability
- A reproduction case (minimal code or step-by-step)
- The affected version range (`npm view @rckflr/agent-skills-cli versions --json`)
- Your proposed severity (Critical / High / Medium / Low) — first-pass; we may adjust
- Whether you'd like credit on the eventual disclosure (default: yes)

### What to expect

- **Acknowledgement within 72 hours** of receipt
- **Initial assessment within 7 days** — confirmation of the vuln + estimated patch timeline
- **Patched release** for Critical/High issues within 14 days; Medium/Low within 30 days
- **Public disclosure** coordinated with the patched release (or 90 days from initial report, whichever comes first, per industry-standard [coordinated vulnerability disclosure](https://www.cve.org/ResourcesSupport/Glossary#vulnerability-disclosure))

---

## In scope

### CLI binary (`agent-skills <cmd>`)

- **Command injection** in `agent-skills exec` / `agent-skills resolve` despite SPEC §2.6 quoting rules
- **Path traversal** in `agent-skills sync` / `agent-skills update` writing outside the bank root
- **Prompt-injection bleed** where SKILL.md content escapes its frame and reaches the LLM in unexpected ways (note: see SPEC's threat model — most prompt-injection in agent-skills is the *agent host's* responsibility, but if a CLI behavior makes it worse, that's in scope here)
- **Bank corruption** via malicious or malformed `skills-index.json` / `SKILL.md` files at sync time
- **Credential leak** despite the **P1 invariant** (credentials never enter LLM context — see spec SECURITY.md §P1). If a code path here causes an env var value to be embedded in a prompt or logged in audit, that's a critical bug.

### Library API (`import` from `@rckflr/agent-skills-cli`)

- Same surface as the CLI, where misuse-by-default could expose consumers to similar issues
- Type-system gaps that allow downstream code to construct invalid SKILL.md objects that pass `validateSkill` but exec unsafely

### Supply chain

- **Tarball tampering** — the v1.0+ npm publish path uses `--provenance` when available; provenance attestations should match the source commit
- **Build-time dependency vulnerabilities** in published dist (we ship pre-built dist/, so a compromised build is a real risk; PRs should flag suspicious changes)

---

## Out of scope

- **The `agent-skills` *spec* itself** — file at the [spec repo](https://github.com/MauricioPerera/agent-skills) instead
- **Threat-model discussion** ("should the spec require X?") — also at the spec repo
- **The agent host's prompt-injection robustness** — that's the responsibility of the LLM runtime (Claude Code, Cursor, etc.), not this CLI
- **Vulnerabilities in user-published packs** — pack publishers are responsible for what they ship; the CLI's job is to enforce the trust-level posture documented in SPEC §5
- **Bugs in dependent packages** (`ajv`, `ajv-formats`, `yaml`) — file with them directly; we'll bump pinned versions if a relevant CVE is published

---

## Trust levels (what this package claims)

| level | what the CLI does | implementation status |
|---|---|---|
| **Level 1** | Content-addressable resolution (every identity contains a SHA) | shipped |
| **Level 2** | Reject server-hosted skills (no commit hash → no ingest) | shipped |
| **Level 3a** | Host-verified GPG/SSH/Sigstore tag signatures via GitHub API | shipped (v0.10.0+) |
| **Level 3b** | Client-verified GPG/SSH against `trusted_keys` | not shipped |
| **Level 4** | Client-verified Sigstore via Rekor inclusion proof + Fulcio chain | spec-only; reference impl parked indefinitely until external pull |

If you're operating at "production agent" tier and need stronger than Level 3a, the design path is documented in spec §5; the implementation is gated on real demand. Contact us if you have a use case.

---

## Hall of fame

Vulnerabilities reported responsibly will be credited here once disclosed. Empty so far — be the first.

---

## What this package does NOT promise

- **No security guarantee for skill content.** This CLI is a runtime — it executes shell commands derived from SKILL.md files you've subscribed to. If you subscribe to a malicious pack, the CLI will obediently run their commands. Trust comes from the signature-verification layer (Level 3a+) and operator review of the packs you sync. Read [PUBLISHING.md](./PUBLISHING.md) and the spec §5 before treating any skill as trustworthy.
- **No SLA.** This is an open-source project shipped under MIT. Best-effort response times above are aspirational, not contractual.
- **No backporting policy yet.** Pre-1.0 versions don't get security patches. v1.0+ patches go to the latest minor of the latest major (`v1.x` today). When a v2.0 ships, the v1.x line gets security-only patches for 6 months per the deprecation window in [STABILITY.md](./STABILITY.md).
