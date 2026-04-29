# Migration Guide

How to upgrade between major versions of `@rckflr/agent-skills-cli`.

This file follows a strict per-major-version section format. Each section is the source of truth for the breaking-change diff between adjacent majors. Minor-version upgrades within the same major (e.g., v1.3 → v1.4) never require migration — see [STABILITY.md](./STABILITY.md) for the policy.

The minor-version notes below (v2.0 → v2.1, v2.1 → v2.2) are NOT migrations — they're additive feature pointers. v2.x consumers can keep their existing skills working as-is; the new fields are opt-in.

---

## v2.1.0 → v2.2.0 *(additive minor — spec v1.2)*

No breaking changes. New optional capability:

- **`filesystem` allowlist** (SPEC §2.11). Skills can now declare `filesystem: ["/etc", "/var/log", …]` to gain read-only access to those host directories in addition to `$AGENT_SCRATCH`. Skills using this field MUST also bump `schema_version: "0.2"`.

  Old skills (`schema_version: "0.1"`, no `filesystem`) keep working with scratch-only behaviour — same as before. New skills opt-in by declaring both fields.

- **New public exports** (per [STABILITY.md](./STABILITY.md)): `buildSandboxFs`, `buildNetworkConfig`. The first lets external integrators build the sandbox FS directly (e.g., for tests); the second exposes the wildcard-translation logic so non-CLI banks can reuse it.

- **Runtime behaviour change** (not breaking, but worth noting): `network: ["https://*"]` and similar wildcards are now translated to `dangerouslyAllowFullInternetAccess: true` + all-methods at the just-bash boundary. Pre-v2.2 those wildcards parsed but matched nothing — silent fail at exec time. v2.2 honours the obvious intent.

Reference pack: agent-skills-pack v2.2.0 ships `read-file` v2.0.0 and `ripgrep-search` v2.0.0 with `filesystem: ["/etc", "/var", "/home", "/tmp", "/usr"]`.

---

## v2.0.0 → v2.1.0 *(additive minor — spec v1.1)*

No breaking changes. New optional capability:

- **Pack-distributed CustomCommands** (SPEC §3.4). Skills can ship a `command.js` ESM module alongside `SKILL.md`:

  ```js
  // skills/my-skill/command.js
  export default ({ defineCommand }) =>
    defineCommand("my-cmd", async (args, ctx) => {
      // ... return { stdout, stderr, exitCode }
    });
  ```

  The bank fetches `command.js` at sync time, stores its source as `command_source` on the indexed skill, and registers the produced Command on the sandbox before exec. This closes the gap that prevented v2 sandboxes from running skills wrapping host CLIs (`gh`, `aws`, …) — the wrapper now travels with the pack.

- **New public exports**: `loadCustomCommandFromSource`, `LoadFailureReason` type, `PackCommandApi` interface. The loader returns null on any shape error and reports a structured reason to an optional `onError` callback so pack authors get diagnosable feedback.

- **Bank schema additive**: `IndexedSkill.command_source?: string` is the new field. `extractFrontmatter` in `runExec` strips it before re-validation; pre-v2.1 callers who relied on the `additionalProperties: false` schema would have rejected it (regression test added in v2.1.0+).

---

## v1.x → v2.0.0

**Breaking changes: 2 (runtime + storage).** Both come from making the CLI conform to the agent-skills spec it claims to implement. Pre-v2 the CLI ran a parallel non-conformant runtime; v2 closes that divergence.

### Runtime: skills now execute under sandboxed just-bash

**v1.x**: `agent-skills exec` spawned `bash -c "<command>"` against the host shell. Any skill could read/write any path, call any URL, and use any binary on the operator's `$PATH`. Host env vars all leaked through.

**v2.0**: `agent-skills exec` runs the substituted command inside a sandboxed [`just-bash`](https://github.com/vercel-labs/just-bash) instance per SPEC §4.4:

- **Filesystem** restricted to a fresh per-skill scratch directory (path exposed to the skill as `$AGENT_SCRATCH`).
- **Network** restricted to the skill's declared `network` allowlist (empty / missing = no HTTP).
- **Env vars** restricted to `required_env ∪ optional_env`.
- **Process spawning** restricted to commands registered in just-bash + just-bash-data's plugin set. There is no `/bin/sh` fallback.

**What this breaks for existing skills**:

| Skill behaviour | v1.x | v2.0 |
|---|---|---|
| Calls `gh`, `aws`, `kubectl`, `psql`, etc. (host binaries not part of just-bash's command set) | works | **fails** unless a CustomCommand wrapper is registered |
| Reads `$ANY_HOST_ENV_VAR` | works | **fails** unless declared in `required_env` / `optional_env` |
| Writes to arbitrary paths | works | **fails** — only `$AGENT_SCRATCH` is writable |
| Makes HTTP calls | works | **fails** unless URL prefix is in skill's `network` allowlist |

**Migration**: pack authors should review every `command_template` against this list. Skills that wrap host CLIs (the dominant pattern in the public pack) require either:
- Re-implementing as a CustomCommand registered with the bank, OR
- Acknowledgement that they only run on banks that have those commands registered, OR
- A move to a different distribution model

The spec describes this trade-off in DESIGN.md §357 and IMPLEMENTATION.md §sandboxing.

### Storage: bank state migrated to just-bash-data db / vec

**v1.x**: bank state stored as JSON files at `<bankDir>`:
- `subscriptions.json` (array of subscriptions)
- `skills/<hash>.json` (one file per skill)
- `audit.jsonl` (newline-delimited audit log)
- `meta.json` (bank metadata)

**v2.0**: bank state stored via [`just-bash-data`](https://www.npmjs.com/package/just-bash-data) collections at `<bankDir>/data/`:
- `db skill_subscriptions` collection
- `db skills` collection
- `db skill_audit` collection
- `vec skills` index for embeddings (replaces in-memory cosine over `skills/`)
- `meta.json` (still file-based for embedding-model coordination)

**What this breaks**: existing v1.x banks at `~/.config/agent-skills/` are not readable by v2. The legacy JSON files are ignored; the bank looks empty on first run.

**Migration**:

```bash
# Option A: re-sync from source (recommended).
agent-skills sync github.com/<your-org>/<pack>@<tag>
# Repeat for every subscription you had in v1.x.

# Option B: blow away and start over.
rm -rf ~/.config/agent-skills
agent-skills sync ...
```

Audit history from v1.x is preserved in `<bankDir>/audit.jsonl` for inspection but not read by v2's `agent-skills audit` command. Operators who need the old log readable in v2's storage can grep / process the file manually; a one-shot import tool is not provided.

### What you don't need to do

- API surface (TypeScript exports) **is unchanged**. The same `import { runExec, FileBank, ... }` calls work. The internal storage and runtime swapped under the same surface.
- SKILL.md format unchanged. Skills you authored under v1 spec v1.0 are valid under v2 / spec v1.0 unchanged.
- `STABILITY.md` tiers unchanged. Same STABLE / EXPERIMENTAL / INTERNAL boundaries.

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
