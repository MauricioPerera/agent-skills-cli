// File-based skill bank for the reference CLI.
//
// State layout (under <root>):
//   subscriptions.json    — array of Subscription records
//   skills/<id-hash>.json — one file per indexed skill (frontmatter + provenance + embedding)
//   meta.json             — bank metadata (embedding model name, etc.)
//
// This is the simplest possible bank that satisfies SPEC §4.1 (subscription
// persistence) + §4.3 (retrieval). For production scale (>10K skills),
// a vector-indexed bank like the just-bash-data reference (IMPLEMENTATION.md)
// is recommended; this one uses brute-force cosine search.

import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SkillFrontmatter } from "../types.js";
import { cosineSimilarity } from "./embed.js";
import { CliError, EXIT } from "./errors.js";

export interface Subscription {
  id: string;
  source_type: "git" | "url";
  repo?: string;
  ref_requested?: string;
  ref_resolved?: string;
  url_template?: string;
  index_url?: string;
  auto_update: boolean;
  last_synced?: string;
  verify_signature?: boolean;
  trusted_keys?: string[];
}

export interface SkillProvenance {
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

export interface IndexedSkill extends SkillFrontmatter {
  /** Full identity per SPEC §1: <source>@<ref>/<path>. Primary key. */
  identity: string;
  provenance: SkillProvenance;
  /** Computed at ingest, locally; SPEC §4.2. */
  embedding: number[];
  /** The provider name + model that produced this embedding. Used to detect mismatch. */
  embedding_model: string;
  inserted_at: string;
  updated_at: string;
}

export interface BankMeta {
  /** Spec schema version this bank's contents target. */
  schema_version: string;
  /** Name of the embedding provider currently in use. */
  embedding_model: string;
  /** Vector dimensionality of the embedding model. */
  embedding_dim: number;
  /** When the bank was created. */
  created_at: string;
}

export interface SearchHit {
  skill: IndexedSkill;
  score: number;
}

export interface BankConfig {
  /** Root directory for the bank's state. Default: ~/.config/agent-skills/ */
  rootDir?: string;
}

/**
 * Hash an identity into a short filesystem-safe filename.
 * Identities can contain `/` and `@` which are not friendly to filenames.
 */
const identityToFilename = (identity: string): string => {
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${hash}.json`;
};

/**
 * Default bank root directory. Per the [XDG Base Directory Spec], we use
 * $XDG_CONFIG_HOME (default ~/.config) for state. Override via BankConfig.rootDir.
 */
export const defaultBankRoot = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return join(xdg, "agent-skills");
  return join(homedir(), ".config", "agent-skills");
};

export class FileBank {
  private readonly rootDir: string;
  private readonly skillsDir: string;
  private readonly subsPath: string;
  private readonly metaPath: string;

  constructor(config: BankConfig = {}) {
    this.rootDir = config.rootDir ?? defaultBankRoot();
    this.skillsDir = join(this.rootDir, "skills");
    this.subsPath = join(this.rootDir, "subscriptions.json");
    this.metaPath = join(this.rootDir, "meta.json");
  }

  /** Ensure all expected directories exist. Idempotent. */
  async ensureDir(): Promise<void> {
    await mkdir(this.skillsDir, { recursive: true });
  }

  /** Initialize (or update) bank metadata with the embedding model in use. */
  async initMeta(meta: Pick<BankMeta, "embedding_model" | "embedding_dim">): Promise<void> {
    await this.ensureDir();
    let existing: BankMeta | null = null;
    try {
      const text = await readFile(this.metaPath, "utf8");
      existing = JSON.parse(text) as BankMeta;
    } catch {
      // not initialized yet
    }

    if (existing && existing.embedding_model !== meta.embedding_model) {
      throw new CliError(
        EXIT.VALIDATION,
        `bank already initialized with embedding model '${existing.embedding_model}'; refusing to mix with '${meta.embedding_model}'. Run 'agent-skills bank reset' to start over.`,
      );
    }

    const written: BankMeta = existing ?? {
      schema_version: "0.1",
      embedding_model: meta.embedding_model,
      embedding_dim: meta.embedding_dim,
      created_at: new Date().toISOString(),
    };
    await writeFile(this.metaPath, JSON.stringify(written, null, 2), "utf8");
  }

  async getMeta(): Promise<BankMeta | null> {
    try {
      const text = await readFile(this.metaPath, "utf8");
      return JSON.parse(text) as BankMeta;
    } catch {
      return null;
    }
  }

  // ─── Subscriptions ───────────────────────────────────────────────────

  async listSubscriptions(): Promise<Subscription[]> {
    try {
      const text = await readFile(this.subsPath, "utf8");
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed as Subscription[];
    } catch {
      return [];
    }
  }

  async upsertSubscription(sub: Subscription): Promise<void> {
    await this.ensureDir();
    const subs = await this.listSubscriptions();
    const idx = subs.findIndex((s) => s.id === sub.id);
    if (idx >= 0) {
      subs[idx] = sub;
    } else {
      subs.push(sub);
    }
    await writeFile(this.subsPath, JSON.stringify(subs, null, 2), "utf8");
  }

  // ─── Skills ──────────────────────────────────────────────────────────

  async upsertSkill(skill: IndexedSkill): Promise<void> {
    await this.ensureDir();
    const path = join(this.skillsDir, identityToFilename(skill.identity));
    await writeFile(path, JSON.stringify(skill, null, 2), "utf8");
  }

  async getSkill(identity: string): Promise<IndexedSkill | null> {
    const path = join(this.skillsDir, identityToFilename(identity));
    try {
      const text = await readFile(path, "utf8");
      return JSON.parse(text) as IndexedSkill;
    } catch {
      return null;
    }
  }

  async listSkills(): Promise<IndexedSkill[]> {
    try {
      const entries = await readdir(this.skillsDir);
      const skills: IndexedSkill[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const text = await readFile(join(this.skillsDir, entry), "utf8");
          skills.push(JSON.parse(text) as IndexedSkill);
        } catch {
          // skip corrupt entries
        }
      }
      return skills;
    } catch {
      return [];
    }
  }

  async removeSkill(identity: string): Promise<boolean> {
    const path = join(this.skillsDir, identityToFilename(identity));
    try {
      await rm(path);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Vector search ───────────────────────────────────────────────────

  /**
   * Brute-force cosine similarity search. Suitable for catalogs up to ~10K
   * skills; for larger, swap in a real ANN index.
   *
   * Filter options:
   *   - applicableOnly: drop skills whose applicable_when conditions don't
   *     match the host environment (currently unimplemented; passes through).
   */
  async search(
    queryEmbedding: number[],
    k: number = 5,
  ): Promise<SearchHit[]> {
    const skills = await this.listSkills();
    const scored: SearchHit[] = skills.map((s) => ({
      skill: s,
      score: cosineSimilarity(queryEmbedding, s.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  // ─── Reset ───────────────────────────────────────────────────────────

  /** Wipe all bank state. Used by 'reset' command. */
  async reset(): Promise<void> {
    try {
      await rm(this.rootDir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }

  /** Public accessor for the root directory (e.g., for CLI UX). */
  get root(): string {
    return this.rootDir;
  }
}
