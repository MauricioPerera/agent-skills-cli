# Contributing

Welcome. This is a small, focused project — contributions of all kinds are wanted, but the bar for changes is "does this serve a real user?" rather than "is this technically interesting?"

## Where to put your time

In rough order of value:

1. **Publish a pack.** [PUBLISHING.md](./PUBLISHING.md) walks you through it. The single biggest move toward "this is a real ecosystem" is more publishers, not more code.
2. **Report a bug** with a minimal reproduction. We respond fast when there's a real issue.
3. **Open an issue** about a real friction you hit using the CLI. Don't open issues for theoretical concerns — open them when you tried something and it didn't work.
4. **Submit a PR** for a fix or small feature. Read the rest of this doc first.
5. **Improve docs.** README clarity, PUBLISHING.md examples, this very file — all welcome.

What we explicitly **don't** want:

- Speculative refactors of working code
- Adding new dependencies "for cleanliness"
- Adding features without a real user pulling for them (see the v1.0 roadmap discussion in README — most of the deferred work was deferred because no one is asking for it)
- Switching test frameworks, build tools, linters

## Setting up

```bash
git clone https://github.com/MauricioPerera/agent-skills-cli
cd agent-skills-cli
npm install
npm run build
npm link    # exposes `agent-skills` on your PATH for local testing
```

Required: **Node ≥ 22**. The project uses native `fetch`, top-level `await`, and ESM-only package layout. Older Node versions will not work.

## The full check loop

```bash
npm run typecheck   # tsc --noEmit; must pass
npm test            # vitest run; must pass
npm run build       # tsup; must succeed
```

CI runs all three on every PR (see `.github/workflows/ci.yml`). PRs failing any of these will not merge.

For end-to-end ecosystem coherence:

```bash
# Triggers the e2e workflow locally — requires Ollama installed + all-minilm pulled.
# Cross-validates that the TS CLI and the Python proof produce identical retrieval
# scores against the public skill pack.
```

E2E lives in `.github/workflows/e2e.yml`. It runs on every push to main and weekly via cron.

## Pull request guidelines

### What makes a good PR

- **Small, focused, single-purpose.** One bug fix or one feature per PR.
- **Tests included** if you change behavior. Vitest under `tests/` mirrors `src/` layout.
- **Type-check passes.** No `any`, no `// @ts-ignore` unless absolutely necessary (and document why).
- **No new dependencies** without discussion. The dep posture (`ajv`, `ajv-formats`, `yaml`) is a deliberate choice; adding to it is a meaningful change.
- **Cross-implementation parity** if your change affects retrieval or signature handling. The Python proof at [`agent-skills-py-proof`](https://github.com/MauricioPerera/agent-skills-py-proof) needs to mirror the TS impl bit-for-bit on the same inputs. The e2e parity job catches drift.
- **Updates to docs** if behavior or API changes (README, STABILITY.md, MIGRATION.md as appropriate).

### What blocks a PR

- Failing CI — fix locally first
- Breaking changes to STABLE exports without a deprecation path (see [STABILITY.md](./STABILITY.md))
- Adding native dependencies (`faiss`, `cryptography`, etc.) without a corresponding user need
- Reformatting unrelated code in the same PR — keep diffs reviewable

### Commit messages

We don't enforce conventional commits, but follow these patterns:

```
v0.x.y: brief description

Longer explanation if non-trivial. What changed and why. What's NOT in
scope. Test impact.
```

Or for non-version commits:

```
fix(area): brief description
```

```
docs: brief description
```

```
ci: brief description
```

The release workflow expects tags `v*.*.*` on main with matching `package.json` version — see `.github/workflows/release.yml`.

## Stability obligations

If you touch a STABLE export (per [STABILITY.md](./STABILITY.md)), think about backward compatibility:

- **Adding** to a stable interface (new optional field, new exported function) is non-breaking — fine in any PR.
- **Removing** or **renaming** a stable export requires a major version bump + deprecation path. Don't do this in a PR; open an issue first to discuss.
- **Changing** behavior of a stable function in a way that breaks existing call sites is a major version concern.

Experimental and Internal exports have weaker guarantees — read their tier in STABILITY.md before changing.

## Cross-implementation parity

This is unusual enough to call out explicitly. The project ships **two reference implementations**:

1. The TS CLI (this repo)
2. A single-file Python proof at [`agent-skills-py-proof`](https://github.com/MauricioPerera/agent-skills-py-proof)

The point of the Python proof is to validate that the spec is sufficient for alternative implementations. They produce **bit-identical retrieval scores** on the same input.

If your PR changes:

- Embedding text composition (SPEC §4.2)
- Signature detection (SPEC §5.1)
- Sigstore identity extraction (SPEC §5.1 v0.3.3)
- gitsign Rekor lookup hash (SPEC §5.4.2 step 3)
- Bench protocol (SPEC §4.6)

…you also need to mirror the change in `agent-skills-py-proof`'s `bank.py`. The e2e parity workflow will fail otherwise. Submit both PRs together (or one PR with a follow-up; mention the dependency).

If your change is purely TS-side (CLI ergonomics, internal refactors, types), no Python work is needed.

## Code review

PRs from external contributors get a review within ~3 days for substantive changes, faster for trivial fixes. The reviewer is mostly the maintainer.

Reviews focus on:

- Does this serve a real user?
- Is the change focused?
- Does it preserve the dep posture?
- Does it preserve cross-impl parity if relevant?
- Are tests adequate?
- Are docs updated?

Style nits get fewer review cycles than substantive concerns. The maintainer may push small fixups directly.

## Releases

Releases are cut by the maintainer. The flow is:

1. Bump `package.json` version on main
2. Update README roadmap row
3. Tag `v*.*.*`
4. Push the tag → triggers `.github/workflows/release.yml` (OIDC + provenance) **OR** falls back to manual `npm publish` if Trusted Publisher is still bugged
5. Create GH release with notes

See [MIGRATION.md](./MIGRATION.md) for the per-major-version migration policy.

## Sister repos

Changes to the agent-skills *spec* go in [`agent-skills`](https://github.com/MauricioPerera/agent-skills), not here. CLI behavior must conform to the spec; if a behavior change requires a spec change, open an issue in the spec repo first to align.

The public skill pack lives at [`agent-skills-pack`](https://github.com/MauricioPerera/agent-skills-pack) and is a working example of a publisher pack. Use it for testing the CLI against real content.

## Questions

- For spec questions: file at [`agent-skills`](https://github.com/MauricioPerera/agent-skills/issues)
- For CLI / library / publishing questions: file [here](https://github.com/MauricioPerera/agent-skills-cli/issues)
- For security concerns: see [SECURITY.md](./SECURITY.md) — do NOT open public issues for security vulns

Thanks for reading this far. Pull requests welcome.
