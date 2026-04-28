// Types mirroring the agent-skills v0.1 SKILL.md schema.
// Fields here match SPEC.md §2 of the agent-skills v0.1.1 draft.

export type ArgType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export interface ArgSpec {
  type: ArgType;
  description?: string;
  default?: unknown;
  sensitive?: boolean;
  unquoted?: boolean;
  pattern?: string;
  enum?: unknown[];
  range?: [number, number];
  items?: ArgSpec; // for type=array
  properties?: Record<string, ArgSpec>; // for type=object
}

export interface ApplicableWhen {
  os?: string[];
  arch?: string[];
  shell_commands_present?: string[];
  env_present?: string[];
  env_absent?: string[];
}

export interface Example {
  intent: string;
  command: string;
  expected_output?: string;
}

export interface Author {
  name: string;
  url?: string;
  email?: string;
}

export interface ChainStep {
  skill: string;
  args?: Record<string, unknown>;
  output_var?: string;
}

export interface SkillFrontmatter {
  // Required
  schema_version: string;
  id: string;
  version: string;
  title: string;
  description: string;
  use_when: string;
  command_template: string;

  // Recommended
  license?: string;
  author?: Author;
  homepage?: string;
  category?: string;
  tags?: string[];
  args?: Record<string, ArgSpec>;
  examples?: Example[];

  // Optional
  shell?: string;
  idempotent?: boolean;
  required_commands?: string[];
  required_env?: string[];
  optional_env?: string[];
  network?: string[];
  applicable_when?: ApplicableWhen;
  deprecates?: string[];
  migration_notes?: string;
  related?: string[];
  chains?: ChainStep[];
  metadata?: Record<string, unknown>;
}

/**
 * Provenance is bank-computed at ingest, NOT in the file. SPEC.md §2.5.
 * Banks store this alongside the parsed frontmatter.
 */
export interface Provenance {
  source_type: "git" | "url";
  source: string;
  ref_resolved_to?: string;
  ref_requested?: string;
  fetched_at: string;
  signature_status: "unsigned" | "valid" | "invalid" | "unverified";
  signed_by?: string;
  publisher_verified?: boolean;
  embedding_truncated?: boolean;
}

/**
 * Full skill record as stored in a bank's index: frontmatter + provenance + bank-managed fields.
 */
export interface IndexedSkill extends SkillFrontmatter {
  identity: string; // full identity per SPEC §1
  provenance?: Provenance;
  inserted_at?: string;
  updated_at?: string;
  usage_count?: number;
  avg_rating?: number | null;
  deprecated?: boolean;
  removed?: boolean;
}

/**
 * The result of parsing a SKILL.md file: frontmatter + raw body markdown.
 */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string; // markdown after the closing `---` of frontmatter
}
