// Public library API for agent-skills-cli.
// CLI users invoke via the `agent-skills` binary (see src/cli.ts).
// Library consumers import these named exports.

export { parseIdentity, formatIdentity, isImmutableIdentity } from "./lib/identity.js";
export type { ParsedIdentity, IdentityRefKind } from "./lib/identity.js";

export { deriveUrls, deriveSkillsIndexUrls, renderTemplate } from "./lib/url.js";
export type { UrlTemplateContext } from "./lib/url.js";

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

export {
  validateFrontmatter,
  validateSpecConstraints,
  validateSkill,
} from "./lib/validate.js";
export type { ValidationError, ValidationResult } from "./lib/validate.js";

export { substituteValue, resolveCommand } from "./lib/substitute.js";
export type { ResolveResult } from "./lib/substitute.js";

export { CliError, EXIT, isCliError } from "./lib/errors.js";
export type { ExitCode } from "./lib/errors.js";

// Embedding providers (Cloudflare + Ollama + OpenAI + stub) + factory + composition.
// v0.6.0 added Ollama and OpenAI-compatible providers + resolveEmbedderFromEnv().
export {
  createCloudflareEmbedder,
  createOllamaEmbedder,
  createOpenAIEmbedder,
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
  ResolveEmbedderOptions,
} from "./lib/embed.js";

// Rerank + applicable filter (v0.4.0+)
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

// Intent embedding cache (v0.5.0+, used internally by intent-conditional rerank)
export { IntentEmbeddingCache } from "./lib/intent-cache.js";

// File-based skill bank
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

// Command entry points (also exposed for programmatic use)
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

// Signature verification (v0.10.0+, used internally by sync)
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

// CMS / Sigstore identity extraction (v0.16.0+) + gitsign Rekor lookup hash (v0.17.1+)
export { extractSigstoreIdentity, computeGitsignRekorLookupHash } from "./lib/cms.js";
export type { SigstoreIdentity } from "./lib/cms.js";

// Rekor entry parsing + lookup (v0.17.0+ — parsing only; verification queued)
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

// Update command (v0.11.0+)
export { runUpdate, printUpdateResult } from "./commands/update.js";
export type {
  UpdateOptions,
  UpdateResult,
  UpdateSubscriptionResult,
} from "./commands/update.js";

// CLI argument helpers (v0.12.0+, used by the bin shim — exposed for
// downstream tooling that wraps the CLI with the same flag conventions)
export { parseArgv, parseRerankMode, parseTenantFlag } from "./lib/cli-args.js";
export type { Argv } from "./lib/cli-args.js";
