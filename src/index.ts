// Public library API for agent-skills-cli.
//
// CLI users invoke via the `agent-skills` binary (see src/cli.ts).
// Library consumers import these named exports.
//
// EXPORTS ARE GROUPED BY STABILITY TIER. The tier of each section is
// declared in its block comment. See STABILITY.md for the breaking-change
// policy that governs each tier.
//
// Summary:
//   - STABLE       — semver-protected; will not change shape until v2.0.
//                    Most of the API is here.
//   - EXPERIMENTAL — shipped, tested, useful for inspection, but the
//                    surrounding feature is incomplete (e.g., Rekor
//                    parsing without verification). Shape may change as
//                    the feature lands.
//   - INTERNAL     — exposed because tooling that wraps the CLI needs
//                    them, but treated as internal-coupling. Shape may
//                    change in any minor release.

// ════════════════════════════════════════════════════════════════════
// STABLE — schema, validation, identity, errors, runtime primitives
// ════════════════════════════════════════════════════════════════════

// Skill identity per SPEC §1.
export { parseIdentity, formatIdentity, isImmutableIdentity } from "./lib/identity.js";
export type { ParsedIdentity, IdentityRefKind } from "./lib/identity.js";

// Skill source parsing (frontmatter + markdown body).
export { parseSkillSource, splitFrontmatter } from "./lib/parse-skill.js";
export type {
  ParsedSkill,
  SkillFrontmatter,
  ArgSpec,
  ArgType,
  ApplicableWhen,
  Example,
  Author,
  ChainStep,
} from "./types.js";

// Schema + spec-constraints validation.
export {
  validateFrontmatter,
  validateSpecConstraints,
  validateSkill,
} from "./lib/validate.js";
export type { ValidationError, ValidationResult } from "./lib/validate.js";

// Argument substitution + command resolution per SPEC §2.6.
export { substituteValue, resolveCommand } from "./lib/substitute.js";
export type { ResolveResult } from "./lib/substitute.js";

// Error model.
export { CliError, EXIT, isCliError } from "./lib/errors.js";
export type { ExitCode } from "./lib/errors.js";

// Embedding providers + factory + composition (SPEC §4.7).
// Adding a NEW provider is non-breaking; the existing factories' shape
// is stable.
export {
  createCloudflareEmbedder,
  createOllamaEmbedder,
  createOpenAIEmbedder,
  createTransformersJSEmbedder,
  createStubEmbedder,
  resolveEmbedderFromEnv,
  composeEmbeddingText,
  cosineSimilarity,
} from "./lib/embed.js";
export type {
  EmbeddingProvider,
  CloudflareEmbedderConfig,
  OllamaEmbedderConfig,
  OpenAIEmbedderConfig,
  TransformersJSEmbedderConfig,
  ResolveEmbedderOptions,
} from "./lib/embed.js";

// Rerank + applicable filter (SPEC §4.3 / §4.4).
export {
  aggregateUsage,
  rerank,
  intentConditionalRerank,
  computeRecency,
} from "./lib/rerank.js";
export type {
  RerankConfig,
  IntentConditionalConfig,
  SkillUsageStats,
  SkillIntentMap,
  RerankInput,
  RerankOutput,
  IntentConditionalOutput,
} from "./lib/rerank.js";
export {
  detectHost,
  detectAvailableCommands,
  checkApplicability,
} from "./lib/applicable.js";
export type { HostContext, ApplicabilityResult } from "./lib/applicable.js";

// File-based skill bank.
export { FileBank, defaultBankRoot } from "./lib/bank.js";
export type {
  Subscription,
  SkillProvenance,
  IndexedSkill,
  BankMeta,
  BankConfig,
  SearchHit,
  AuditEntry,
} from "./lib/bank.js";

// Command entry points (also exposed for programmatic use).
export { runValidate, printValidateResult } from "./commands/validate.js";
export type { ValidateOptions, ValidateResult } from "./commands/validate.js";

export { runResolve, printResolveResult } from "./commands/resolve.js";
export type { ResolveOptions, ResolveOutput } from "./commands/resolve.js";

export { runSync } from "./commands/sync.js";
export type {
  SyncOptions,
  SyncResult,
  SyncSkillResult,
} from "./commands/sync.js";

export { runQuery, printQueryResult } from "./commands/query.js";
export type {
  QueryOptions,
  QueryResult,
  QueryHit,
  FilteredOut,
  RerankMode,
} from "./commands/query.js";

export { runExec, printExecResult } from "./commands/exec.js";
export type { ExecOptions, ExecResult } from "./commands/exec.js";

export { runBench, printBenchResult } from "./commands/bench.js";
export type {
  BenchOptions,
  BenchResult,
  BenchQueryResult,
  BenchTruthEntry,
} from "./commands/bench.js";

export { runPublish, printPublishResult } from "./commands/publish.js";
export type {
  PublishOptions,
  PublishResult,
  PublishSkillResult,
} from "./commands/publish.js";

export { runInit, printInitResult } from "./commands/init.js";
export type { InitOptions, InitResult } from "./commands/init.js";

export { runUpdate, printUpdateResult } from "./commands/update.js";
export type {
  UpdateOptions,
  UpdateResult,
  UpdateSubscriptionResult,
} from "./commands/update.js";

// Signature verification — Level 3a complete (SPEC §5.1 / §5.2).
// Sigstore identity extraction is shipped and used (SPEC §5.1 v0.3.3).
export {
  verifyGitHubTag,
  enforceVerification,
  detectSignatureMethod,
} from "./lib/signature.js";
export type {
  SignatureStatus,
  SignatureMethod,
  SignatureVerification,
} from "./lib/signature.js";
export { extractSigstoreIdentity } from "./lib/cms.js";
export type { SigstoreIdentity } from "./lib/cms.js";

// ════════════════════════════════════════════════════════════════════
// EXPERIMENTAL — shipped foundations whose surrounding feature is
// incomplete. The shape may change when the feature lands.
// ════════════════════════════════════════════════════════════════════
//
// Rekor primitives + gitsign Rekor lookup hash. Parsing + lookup are
// done; client-side Level 4 verification (Merkle inclusion proof,
// checkpoint signature, Fulcio chain validation) is queued. When that
// work lands, these primitives may be re-shaped to fit a higher-level
// `verifyRekorEntry` surface — at which point a migration shim will
// be provided. Until then, depending on these is fine for inspection
// (e.g., audit tooling) but not as part of a long-term verification
// workflow. See STABILITY.md.

export { computeGitsignRekorLookupHash } from "./lib/cms.js";

export {
  parseRekorEntry,
  fetchRekorEntry,
  findRekorEntryByHash,
  REKOR_PUBLIC_HOST,
} from "./lib/rekor.js";
export type {
  RekorEntry,
  RekorInclusionProof,
  RekorHashedrekordBody,
} from "./lib/rekor.js";

// ════════════════════════════════════════════════════════════════════
// INTERNAL — exposed because tooling that wraps the CLI uses them,
// but treated as internal coupling. Shape may change in any minor
// release. Prefer the higher-level command entry points (runValidate
// etc.) for stable integrations.
// ════════════════════════════════════════════════════════════════════

// CLI argument parsing helpers (used by the bin shim, exposed for
// downstream wrappers that want the same flag conventions).
export { parseArgv, parseRerankMode, parseTenantFlag } from "./lib/cli-args.js";
export type { Argv } from "./lib/cli-args.js";

// URL derivation — used by sync to map (repo, sha, path) → CDN URLs.
// Internal because the URL template strategy may evolve as more hosts
// are supported (currently github.com via jsDelivr).
export { deriveUrls, deriveSkillsIndexUrls, renderTemplate } from "./lib/url.js";
export type { UrlTemplateContext } from "./lib/url.js";

// Intent embedding cache used by intent-conditional rerank. The cache
// is a perf optimization; the rerank API is stable but the cache shape
// is implementation detail.
export { IntentEmbeddingCache } from "./lib/intent-cache.js";

// just-bash runtime + db helpers per SPEC §4.4 / IMPLEMENTATION.md.
// Exposed for downstream tooling that wants to issue db/vec commands
// against the same bank state the CLI uses. EXPERIMENTAL while the
// storage migration is in progress.
export {
  createBashRuntime,
  createBankBash,
  createSandboxedExec,
  buildSandboxFs,
  buildNetworkConfig,
  cleanupScratch,
  loadCustomCommandFromSource,
  runBashCommand,
  dbInsert,
  dbFind,
  dbUpdate,
  dbRemove,
  dbCount,
  vecCreate,
  vecStore,
  vecSearch,
  vecRemove,
} from "./lib/runtime.js";
export type {
  BashRuntimeOptions,
  BankBashOptions,
  SandboxedExecOptions,
} from "./lib/runtime.js";
