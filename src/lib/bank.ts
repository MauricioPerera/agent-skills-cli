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

import { appendFile, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Bash } from "just-bash";
import type { SkillFrontmatter } from "../types.js";
import { cosineSimilarity } from "./embed.js";
import { CliError, EXIT } from "./errors.js";
import { createBankBash, dbCount, dbFind, dbInsert, dbRemove, dbUpdate } from "./runtime.js";

/**
 * Distinguish "file/dir not present yet" (which is normal for fresh banks)
 * from any other I/O failure (permission denied, EIO, JSON corruption, …).
 * Used so the bank treats a missing meta.json as "not initialized" while
 * still surfacing real failures to the operator instead of silently lying.
 */
const isMissing = (err: unknown): boolean => {
  if (err === null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export interface Subscription {
  id: string;
  /**
   * Source type. Currently only `"git"` is supported (v0.13.3+).
   *
   * The `"url"` variant was aspirational since v0.1 — it was for
   * server-hosted skills (SPEC §3.3) consumed via a single HTTPS URL
   * with no commit-hash provenance. No code path ever produced or
   * consumed it; the type is now narrowed to reflect implementation
   * reality. If/when server-hosted ingestion lands (spec v0.4 design
   * decision), the type will be re-widened with deliberate behaviour.
   */
  source_type: "git";
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
  /** See Subscription.source_type — same narrowing in v0.13.3+. */
  source_type: "git";
  source: string;
  ref_resolved_to?: string;
  ref_requested?: string;
  fetched_at: string;
  signature_status: "unsigned" | "valid" | "invalid" | "unverified";
  signed_by?: string;
  /**
   * Signing method when status === "valid" or "invalid" (v0.14.0+, "ssh" added v0.15.0).
   * "gpg"      — classic OpenPGP signature.
   * "ssh"      — SSH-format git signature (gpg.format=ssh; SSH pubkey on the
   *              publisher's GitHub account).
   * "sigstore" — gitsign / Sigstore CMS signature (Fulcio cert + Rekor entry).
   * Detection is structural (PEM header). For Sigstore, GitHub validates the
   * cert at lookup time, so an expired Fulcio cert returns reason="bad_cert"
   * for a properly-signed tag — full Rekor inclusion-proof verification is the
   * sound Level 4 path and is not yet implemented client-side.
   */
  signature_method?: "gpg" | "ssh" | "sigstore";
  /**
   * Sigstore identity claim from the Fulcio cert (v0.16.0+). Populated only
   * when signature_method === "sigstore" and CMS parsing succeeds.
   *
   *   - subject:      OIDC subject from cert SAN (email or workflow URI).
   *   - subject_type: "email" | "uri" | "other".
   *   - issuer:       OIDC issuer URL from Fulcio extension 1.3.6.1.4.1.57264.1.1
   *                   or .1.8 (e.g., "https://accounts.google.com",
   *                   "https://token.actions.githubusercontent.com").
   *
   * IMPORTANT: this is the cert's CLAIMED identity. Verifying the claim
   * against Rekor is Level 4 work (queued). Operators may surface this for
   * informational purposes (e.g., "publisher claims to be <subject> via
   * <issuer>") but MUST NOT treat it as authenticated by extraction alone.
   */
  signature_identity?: {
    subject: string;
    subject_type: "email" | "uri" | "other";
    issuer?: string;
  };
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

/**
 * Audit log entry per SPEC §4.5. Banks SHOULD record one of these per exec
 * invocation. Sensitive arg values are redacted upstream (in resolveCommand).
 */
export interface AuditEntry {
  /** ISO-8601 timestamp at exec start. Doubles as primary key. */
  timestamp: string;
  /** Full skill identity per SPEC §1. */
  skill_id: string;
  /** Optional: the natural-language intent that led to this skill (from query). */
  intent?: string;
  /**
   * Optional: tenant identifier for multi-tenant deployments (SPEC §4.5.1, v0.12.0+).
   *
   * When the bank is shared by multiple agents/users, set this on every
   * exec to scope the audit log per tenant. Intent-conditional rerank
   * filters past entries to only those matching the current query's
   * tenant — Alice's heavy use of base64-encode never bleeds into Bob's
   * retrieval boost.
   *
   * If unset (the default for single-user deployments), the audit log is
   * treated as a single shared history and rerank uses every entry.
   */
  tenant?: string;
  /** Substituted args at call time. Sensitive values are redacted to "<redacted>". */
  args: Record<string, unknown>;
  /** Process exit code. 0 = success. */
  exit_code: number;
  /** Wall-clock elapsed time. */
  elapsed_ms: number;
  /** Optional: agent or user rating, 1-5. */
  rating?: number;
  /** Optional: free-form notes. */
  notes?: string;
  /** Whether stdout was captured (some banks may not store the body for size). */
  stdout_bytes?: number;
  /** Whether stderr was non-empty. */
  stderr_bytes?: number;
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
  private readonly auditPath: string;

  /**
   * In-memory cache for listSkills() (v0.13.0+). Each FileBank instance
   * caches the parsed skill set on first read; subsequent reads are O(1).
   * The cache is invalidated by every mutation (upsertSkill, removeSkill,
   * reset). Process-lifetime only — a new FileBank instance starts cold.
   *
   * Why instance-scoped, not module-level: tests construct disposable
   * banks in tmp dirs; sharing a global cache across instances would
   * corrupt test state.
   *
   * Why no TTL: the bank file is always authoritative on the local disk,
   * and the only writers are this very class. Stale cache is impossible
   * unless an external process modifies the bank — in which case the
   * caller should construct a fresh FileBank anyway.
   */
  private skillsCache: IndexedSkill[] | null = null;

  /**
   * In-memory cache for the audit log (v0.13.1+). Same instance-scoped
   * pattern as skillsCache. Holds the parsed audit set in FILE order
   * (oldest-first); listAudit applies filters, reverses to newest-first,
   * and slices on each call — the expensive parse work happens once per
   * cache miss.
   *
   * appendAudit appends to the cache rather than invalidating, so the
   * common "exec → next query reads audit" path stays O(1) after the
   * initial cache fill. reset() drops the cache.
   *
   * Per-instance, no TTL — same caveats as skillsCache.
   */
  private auditCacheAll: AuditEntry[] | null = null;

  /**
   * Lazy just-bash runtime for db / vec collections. Created on first
   * access and reused for the lifetime of this FileBank instance.
   * Storage migration in progress (subscriptions ported v0.20.0+);
   * collections that still live as JSON files use the legacy paths
   * above and ignore this field.
   */
  private bashInstance: Bash | null = null;

  constructor(config: BankConfig = {}) {
    this.rootDir = config.rootDir ?? defaultBankRoot();
    this.skillsDir = join(this.rootDir, "skills");
    this.subsPath = join(this.rootDir, "subscriptions.json");
    this.metaPath = join(this.rootDir, "meta.json");
    this.auditPath = join(this.rootDir, "audit.jsonl");
  }

  /** Lazily build the bank-scoped just-bash runtime. */
  private getBash(): Bash {
    if (this.bashInstance === null) {
      this.bashInstance = createBankBash({ bankDir: this.rootDir });
    }
    return this.bashInstance;
  }

  /** Internal: drop the listSkills cache. Called by every mutator. */
  private invalidateSkillsCache(): void {
    this.skillsCache = null;
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
    } catch (err) {
      if (!isMissing(err)) {
        // Permission error, EIO, or corrupted JSON — surface it instead of
        // silently re-initialising over a half-broken bank.
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          EXIT.RUNTIME,
          `bank meta.json exists at ${this.metaPath} but is unreadable: ${msg}. ` +
            `If corruption, run 'agent-skills reset' to start over.`,
        );
      }
      // ENOENT: not initialized yet, normal first-run path.
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
    let text: string;
    try {
      text = await readFile(this.metaPath, "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        EXIT.RUNTIME,
        `cannot read bank meta.json at ${this.metaPath}: ${msg}`,
      );
    }
    try {
      return JSON.parse(text) as BankMeta;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        EXIT.RUNTIME,
        `bank meta.json at ${this.metaPath} is not valid JSON: ${msg}. ` +
          `Run 'agent-skills reset' to start over.`,
      );
    }
  }

  // ─── Subscriptions ───────────────────────────────────────────────────
  //
  // Backed by `db skill_subscriptions` per IMPLEMENTATION.md. The on-disk
  // `subscriptions.json` is no longer read; just-bash-data persists docs
  // under <bankDir>/data/. The app-level type uses `id`; the db uses `_id`
  // (just-bash-data convention) — translated at the boundary here.

  async listSubscriptions(): Promise<Subscription[]> {
    const docs = await dbFind<Subscription & { _id: string }>(
      this.getBash(),
      "skill_subscriptions",
      {},
      { sort: "last_synced:1" },
    );
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: _id }) as unknown as Subscription);
  }

  async upsertSubscription(sub: Subscription): Promise<void> {
    const { id, ...rest } = sub;
    const bash = this.getBash();
    // just-bash-data's `db update` does not support upsert semantics
    // (see runtime.ts dbUpdate jsdoc). Pattern: count → insert if
    // missing, else update. The two-step is non-atomic but acceptable
    // for the bank's single-process model.
    const exists = await dbCount(bash, "skill_subscriptions", { _id: id });
    if (exists === 0) {
      await dbInsert(bash, "skill_subscriptions", { _id: id, ...rest });
    } else {
      await dbUpdate(
        bash,
        "skill_subscriptions",
        { _id: id },
        { $set: { _id: id, ...rest } },
      );
    }
  }

  // ─── Skills ──────────────────────────────────────────────────────────
  //
  // Backed by `db skills` per IMPLEMENTATION.md. The on-disk
  // `skills/<hash>.json` directory is no longer read or written.
  // The IndexedSkill type uses `identity` as the primary key; the db
  // uses `_id` (just-bash-data convention) — mapped at the boundary.

  /**
   * Convert an IndexedSkill (app-level) to the doc shape stored in db
   * (db convention: `_id` is the primary key). The `identity` field is
   * preserved alongside `_id` so consumers can still see it on read.
   */
  private skillToDoc(skill: IndexedSkill): Record<string, unknown> {
    return { _id: skill.identity, ...skill };
  }

  /** Strip the db-internal `_id` from a fetched doc; the app uses `identity`. */
  private docToSkill(doc: Record<string, unknown>): IndexedSkill {
    const { _id: _ignored, ...rest } = doc as unknown as IndexedSkill & { _id?: string };
    return rest;
  }

  async upsertSkill(skill: IndexedSkill): Promise<void> {
    const bash = this.getBash();
    const exists = await dbCount(bash, "skills", { _id: skill.identity });
    const doc = this.skillToDoc(skill);
    if (exists === 0) {
      await dbInsert(bash, "skills", doc);
    } else {
      await dbUpdate(bash, "skills", { _id: skill.identity }, { $set: doc });
    }
    this.invalidateSkillsCache();
  }

  async getSkill(identity: string): Promise<IndexedSkill | null> {
    const docs = await dbFind<Record<string, unknown>>(
      this.getBash(),
      "skills",
      { _id: identity },
      { limit: 1 },
    );
    if (docs.length === 0) return null;
    return this.docToSkill(docs[0]!);
  }

  async listSkills(): Promise<IndexedSkill[]> {
    if (this.skillsCache !== null) return this.skillsCache;
    const docs = await dbFind<Record<string, unknown>>(
      this.getBash(),
      "skills",
      {},
    );
    const skills = docs.map((d) => this.docToSkill(d));
    this.skillsCache = skills;
    return skills;
  }

  async removeSkill(identity: string): Promise<boolean> {
    const result = await dbRemove(
      this.getBash(),
      "skills",
      { _id: identity },
    );
    if (result.removed > 0) {
      this.invalidateSkillsCache();
      return true;
    }
    return false;
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

  // ─── Identity resolution ─────────────────────────────────────────────

  /**
   * Find skills by their short `id` (the frontmatter field, e.g., "http-get"),
   * not the full identity. Returns ALL matches — possibly multiple if two
   * subscribed packs both publish a skill with the same id.
   */
  async findByShortId(shortId: string): Promise<IndexedSkill[]> {
    const all = await this.listSkills();
    return all.filter((s) => s.id === shortId);
  }

  /**
   * Resolve a user-supplied identifier to a unique skill. Accepts either:
   *   - A full identity (`<source>@<ref>/<path>`)
   *   - A short id (`http-get`); requires exactly one match in the bank.
   *
   * Throws CliError on ambiguity (multiple matches) or not-found.
   */
  async resolveIdentifier(input: string): Promise<IndexedSkill> {
    // First try direct lookup by full identity
    const direct = await this.getSkill(input);
    if (direct !== null) return direct;

    // Then try short id resolution
    const matches = await this.findByShortId(input);
    if (matches.length === 1) return matches[0] as IndexedSkill;

    if (matches.length > 1) {
      const candidates = matches.map((s) => s.identity).join("\n  - ");
      throw new CliError(
        EXIT.USAGE,
        `'${input}' is ambiguous; multiple skills match:\n  - ${candidates}\nUse the full identity instead.`,
      );
    }

    throw new CliError(
      EXIT.NOT_FOUND,
      `no skill found matching '${input}' in bank ${this.rootDir}. Run 'agent-skills sync <repo>' or check 'agent-skills list'.`,
    );
  }

  // ─── Audit log (append-only JSONL) ──────────────────────────────────

  /**
   * Append a single audit entry. JSONL format: one JSON object per line.
   * Append-only so the log is tamper-evident at the filesystem level.
   */
  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.auditPath, line, "utf8");
    // If we have a cache, keep it in sync rather than invalidating: the
    // exec → next query path is the common case and benefits from O(1)
    // append. If the cache is null, leave it null — next listAudit will
    // build it fresh. (Don't fill the cache here on cold paths; that's
    // listAudit's responsibility.)
    if (this.auditCacheAll !== null) {
      this.auditCacheAll.push(entry);
    }
  }

  /**
   * Read recent audit entries, optionally filtered by skill_id. Returns the
   * MOST RECENT first (newest at index 0).
   *
   * Caching (v0.13.1+): the parsed audit log is cached in file order on
   * the FileBank instance. Filters / reverse / slice run on every call
   * but skip the parse + I/O work once the cache is warm. appendAudit
   * extends the cache; reset drops it.
   */
  async listAudit(opts: { limit?: number; skill_id?: string } = {}): Promise<AuditEntry[]> {
    let all = this.auditCacheAll;
    if (all === null) {
      let text: string;
      try {
        text = await readFile(this.auditPath, "utf8");
      } catch (err) {
        if (isMissing(err)) {
          // No audit log yet. Cache the empty result so repeated cold
          // calls don't keep re-attempting the read.
          this.auditCacheAll = [];
          return [];
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          EXIT.RUNTIME,
          `cannot read audit log at ${this.auditPath}: ${msg}`,
        );
      }
      const lines = text.split("\n").filter((l) => l.length > 0);
      all = [];
      for (const line of lines) {
        try {
          all.push(JSON.parse(line) as AuditEntry);
        } catch {
          // skip corrupt lines (the whole point of JSONL is partial-failure resilience)
        }
      }
      this.auditCacheAll = all;
    }

    // Apply filters on the cached set.
    const filtered = opts.skill_id !== undefined
      ? all.filter((e) => e.skill_id === opts.skill_id)
      : all.slice(); // copy so .reverse() doesn't mutate the cache

    filtered.reverse(); // newest first
    return opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
  }

  // ─── Reset ───────────────────────────────────────────────────────────

  /** Wipe all bank state. Used by 'reset' command. */
  async reset(): Promise<void> {
    try {
      await rm(this.rootDir, { recursive: true, force: true });
    } catch {
      // already gone
    }
    this.invalidateSkillsCache();
    this.auditCacheAll = null;
    // Drop the cached just-bash runtime — its in-memory state (and the
    // ReadWriteFs binding to a now-deleted directory) is no longer valid.
    // The next read/write rebuilds a fresh Bash against the fresh dir.
    this.bashInstance = null;
  }

  /** Public accessor for the root directory (e.g., for CLI UX). */
  get root(): string {
    return this.rootDir;
  }
}
