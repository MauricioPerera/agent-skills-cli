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

// Embedding providers (Cloudflare + stub) and embedding-text composition
export {
  createCloudflareEmbedder,
  createStubEmbedder,
  composeEmbeddingText,
  cosineSimilarity,
} from "./lib/embed.js";
export type { EmbeddingProvider, CloudflareEmbedderConfig } from "./lib/embed.js";

// File-based skill bank
export { FileBank, defaultBankRoot } from "./lib/bank.js";
export type {
  Subscription,
  SkillProvenance,
  IndexedSkill,
  BankMeta,
  BankConfig,
  SearchHit,
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
export type { QueryOptions, QueryResult, QueryHit } from "./commands/query.js";
