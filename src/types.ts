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
  /**
   * Host filesystem path allowlist. Read-only access to declared host
   * directories, in addition to `$AGENT_SCRATCH`. Each entry is a host-
   * absolute directory path. Per SPEC §2.11 (added in spec v1.2 / schema 0.2).
   *
   * Skills using this field MUST declare `schema_version: "0.2"`. A v0.1
   * skill with this field is rejected at validation by the cross-field
   * constraint in schemas/skill.schema.json.
   *
   * Sandboxed banks MUST grant read-only access to these paths and MUST
   * still block writes outside `$AGENT_SCRATCH`.
   */
  filesystem?: string[];
  applicable_when?: ApplicableWhen;
  deprecates?: string[];
  migration_notes?: string;
  related?: string[];
  chains?: ChainStep[];
  metadata?: Record<string, unknown>;
}

/**
 * The result of parsing a SKILL.md file: frontmatter + raw body markdown.
 *
 * Note: bank-managed fields (provenance, embedding, usage_count, etc.) live
 * in the IndexedSkill type from lib/bank.ts, NOT here. Per SPEC §2.5,
 * provenance is computed at ingest, not declared by the author.
 */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string; // markdown after the closing `---` of frontmatter
}
