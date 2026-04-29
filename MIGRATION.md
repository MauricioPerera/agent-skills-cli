# Migration Guide

How to upgrade between major versions of `@rckflr/agent-skills-cli`.

This file follows a strict per-major-version section format. Each section is the source of truth for the breaking-change diff between adjacent majors. Minor-version upgrades within the same major (e.g., v1.3 → v1.4) never require migration — see [STABILITY.md](./STABILITY.md) for the policy.

---

## v0.x → v1.0.0

**Breaking changes: none.**

v1.0.0 ships with **zero API changes** versus v0.19.0. The only thing that changes is the **stability commitment**: from this point forward, every export tagged STABLE in `STABILITY.md` is under semver and protected by a 6-month deprecation window before removal.

### What you don't need to do
- Don't update any `import` statements — every export from v0.19.0 is unchanged in name, signature, and shape.
- Don't update any `package.json` ranges except the version itself: `^1.0.0` works as expected.
- Don't expect new behaviors. If your queries returned the same hits at v0.19.0, they return the same hits at v1.0.0.

### What you should review

- [`STABILITY.md`](./STABILITY.md) — confirm the exports you depend on are in the **STABLE** tier. If you depend on anything in the **EXPERIMENTAL** tier (Rekor primitives, gitsign lookup hash) or **INTERNAL** tier (cli-args helpers, URL helpers, intent cache), expect those to potentially shift at minor releases.
- The companion [agent-skills spec v1.0.0](https://github.com/MauricioPerera/agent-skills/blob/main/SPEC.md) — also stabilizes at v1.0 with the same semver guarantees on the protocol surface (SKILL.md fields, identity format, retrieval semantics, trust levels).

### Compatibility note for SKILL.md `schema_version`

The on-disk `schema_version` field in SKILL.md remains **`"0.1"`** at v1.0. The schema string and the spec/library version are independent: schema_version increments only when the SKILL.md format itself gains a non-additive change. v0.x and v1.0 banks share identical SKILL.md format, so the value stays the same.

---

## Format for future entries

Each new major version (v2.0, v3.0, …) appends a section here with the structure:

```markdown
## v(N-1).x → vN.0.0

**Breaking changes:** [explicit count + brief list]

### Removed exports
- `oldFunction()` — replaced by `newFunction()`. Migration: …
- (etc.)

### Changed signatures
- `existingFn(opts)`: `opts.foo` renamed to `opts.bar`. Migration: …

### Changed behavior
- `xyz()` now returns `null` instead of throwing on …. Migration: …

### Deprecation timeline
- v(N-1).M.0 — old export marked `@deprecated`
- v(N-1).M+K.0 — release notes warn of upcoming removal
- vN.0.0 — old export removed
```

Every entry must include:
- An explicit count of breaking changes (zero counts as "Breaking changes: none")
- For each removed/changed export, the migration path with code-level instruction
- The deprecation timeline that preceded the removal (per the 6-month window in `STABILITY.md`)

---

## Reporting unexpected breakage

If you upgraded between minor versions (e.g., v1.3 → v1.4) and your code broke, that's a stability-policy violation, not an expected migration. Open an issue at https://github.com/MauricioPerera/agent-skills-cli/issues with:

- The previous and new version numbers
- The export(s) affected
- A minimal reproduction

We'll patch the regression and document the slip-up. The point of this policy is that minor-version upgrades within a major are never something you have to think about.
