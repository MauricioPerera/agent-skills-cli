# API Stability Policy

This document defines the stability tiers for `@rckflr/agent-skills-cli`'s public library API and the breaking-change policy that applies to each. The CLI binary surface (`agent-skills <command>` flags) is governed separately by SPEC §6 versioning rules.

This policy takes effect at **v0.19.0** as preparation for v1.0. Pre-0.19 releases were not covered.

---

## Tiers

### `STABLE`

Semver-protected. Breaking changes (renames, removals, signature changes) require:

- **a major version bump** (v1.0 → v2.0), AND
- **a minimum 6-month deprecation window** during which the old export continues to work alongside the new one with a JSDoc `@deprecated` tag, AND
- **a migration entry in CHANGELOG / release notes** explaining the move.

Stable exports include all of the schema/spec types, validation, identity, error model, embedding providers, bank API, command entry points, rerank, applicable filter, signature verification at Level 3a, and Sigstore identity extraction.

Adding new fields or new exports is non-breaking. Adding optional fields to interfaces is non-breaking. Removing or renaming is breaking.

### `EXPERIMENTAL`

Shipped, tested, useful for inspection — but the **surrounding feature is incomplete**, so the API shape may evolve as the feature lands.

Breaking changes can happen in any **minor release** (v0.x.y → v0.(x+1).0) with a release-note entry. They will not happen in patch releases (v0.x.y → v0.x.(y+1)).

Currently experimental:

- Rekor entry parsing + lookup primitives (`parseRekorEntry`, `fetchRekorEntry`, `findRekorEntryByHash`, `REKOR_PUBLIC_HOST` and the Rekor type exports)
- gitsign Rekor lookup hash (`computeGitsignRekorLookupHash`)

These will graduate to STABLE when **Phase 2 of Level 4 verification** ships (Merkle inclusion-proof verifier + checkpoint signature + Fulcio chain validator + identity matching). At that point the higher-level `verifyRekorEntry`-style surface may absorb some of these primitives; a migration shim will be provided.

### `INTERNAL`

Exposed because the CLI binary or downstream tooling that wraps it uses them, **but treated as internal coupling**. Shape may change in any minor release with no migration shim.

Library consumers SHOULD prefer the stable surface. Internal exports are useful when:

- You're building a CLI wrapper that needs the same flag-parsing conventions (`parseArgv`, `parseRerankMode`, `parseTenantFlag`).
- You're prototyping integrations and don't mind churn.

If you find yourself depending on an INTERNAL export for a long-term product, file an issue requesting it be promoted to STABLE — we'd rather know.

Currently internal:

- CLI argument parsing helpers (`parseArgv`, `parseRerankMode`, `parseTenantFlag`, `Argv`)
- URL derivation (`deriveUrls`, `deriveSkillsIndexUrls`, `renderTemplate`, `UrlTemplateContext`)
- Intent embedding cache (`IntentEmbeddingCache`)

---

## Per-export reference

The full categorization lives inline in [`src/index.ts`](./src/index.ts) — exports are grouped by tier with section headers. The list below is a snapshot at v0.19.0.

### Stable (semver-protected)

| Module | Exports |
|---|---|
| Identity | `parseIdentity`, `formatIdentity`, `isImmutableIdentity`, `ParsedIdentity`, `IdentityRefKind` |
| Skill parsing | `parseSkillSource`, `splitFrontmatter`, `ParsedSkill`, `SkillFrontmatter`, `ArgSpec`, `ArgType`, `ApplicableWhen`, `Example`, `Author`, `ChainStep` |
| Validation | `validateFrontmatter`, `validateSpecConstraints`, `validateSkill`, `ValidationError`, `ValidationResult` |
| Substitution | `substituteValue`, `resolveCommand`, `ResolveResult` |
| Errors | `CliError`, `EXIT`, `isCliError`, `ExitCode` |
| Embedding | `createCloudflareEmbedder`, `createOllamaEmbedder`, `createOpenAIEmbedder`, `createStubEmbedder`, `resolveEmbedderFromEnv`, `composeEmbeddingText`, `cosineSimilarity`, `EmbeddingProvider`, `*EmbedderConfig`, `ResolveEmbedderOptions` |
| Rerank | `aggregateUsage`, `rerank`, `intentConditionalRerank`, `computeRecency`, `RerankConfig`, `IntentConditionalConfig`, `SkillUsageStats`, `SkillIntentMap`, `RerankInput`, `RerankOutput`, `IntentConditionalOutput` |
| Applicable filter | `detectHost`, `detectAvailableCommands`, `checkApplicability`, `HostContext`, `ApplicabilityResult` |
| Bank | `FileBank`, `defaultBankRoot`, `Subscription`, `SkillProvenance`, `IndexedSkill`, `BankMeta`, `BankConfig`, `SearchHit`, `AuditEntry` |
| Commands | `runValidate`, `runResolve`, `runSync`, `runQuery`, `runExec`, `runBench`, `runPublish`, `runInit`, `runUpdate` (+ their `print*` and `Options`/`Result` types) |
| Signature | `verifyGitHubTag`, `enforceVerification`, `detectSignatureMethod`, `SignatureStatus`, `SignatureMethod`, `SignatureVerification` |
| Sigstore identity | `extractSigstoreIdentity`, `SigstoreIdentity` |

### Experimental (shape may change at minor versions)

| Module | Exports |
|---|---|
| Rekor primitives | `parseRekorEntry`, `fetchRekorEntry`, `findRekorEntryByHash`, `REKOR_PUBLIC_HOST`, `RekorEntry`, `RekorInclusionProof`, `RekorHashedrekordBody` |
| gitsign Rekor | `computeGitsignRekorLookupHash` |

### Internal (no shape guarantees at any release)

| Module | Exports |
|---|---|
| CLI args | `parseArgv`, `parseRerankMode`, `parseTenantFlag`, `Argv` |
| URL helpers | `deriveUrls`, `deriveSkillsIndexUrls`, `renderTemplate`, `UrlTemplateContext` |
| Intent cache | `IntentEmbeddingCache` |

---

## How tiers move

**Promotion (EXPERIMENTAL → STABLE).** Happens when the surrounding feature is complete and we've used the API for ≥1 minor release without finding shape issues. Listed as a release-note item.

**Demotion (STABLE → EXPERIMENTAL).** Doesn't happen. If we got something stable wrong, we deprecate via the major-version path described above.

**Removal from public API.** A stable export can become `INTERNAL` only at a major version bump, with a 6-month deprecation window where the export continues to be re-exported from the public path with `@deprecated`.

---

## Versioning summary

| change | minor bump (v0.x.y → v0.(x+1).0) | major bump (v0.x.y → v1.0.0) |
|---|---|---|
| Add new STABLE export | ✅ | — |
| Add optional field to STABLE interface | ✅ | — |
| Change shape of EXPERIMENTAL export | ✅ (with release note) | — |
| Change shape of INTERNAL export | ✅ (no announcement required) | — |
| Rename / remove STABLE export | ❌ — never in minor | ✅ with 6-month deprecation window |
| Promote EXPERIMENTAL → STABLE | ✅ (with release note) | — |
| Spec semantics shift (e.g., embedding text composition) | depends on backward-compat impact; case by case | major if it breaks consumers |

---

## What this document is NOT

- **Not a stability claim about the npm registry availability.** That's covered separately by npm's own SLA + the package being maintained.
- **Not a security policy.** See SECURITY.md for the threat model and trust levels.
- **Not a spec stability policy.** SPEC versioning is governed by the agent-skills spec repo's own §6.

---

## Reporting stability concerns

If a STABLE export changed shape unintentionally between releases (i.e., we broke our own policy), open an issue at https://github.com/MauricioPerera/agent-skills-cli/issues with the affected export name and the version range. We'll patch the regression and document the slip-up in the next release.
