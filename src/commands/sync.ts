// `agent-skills sync <repo>@<ref>` — fetch skills from a git source, embed,
// and ingest into the local bank.
//
// Steps per SPEC.md §7.1:
//   1. Parse the user's repo + ref string into an identity.
//   2. Resolve ref → commit hash (via host's git API, e.g., GitHub).
//   3. Fetch /skills-index.json from the CDN at the resolved hash.
//   4. For each skill in the index: fetch SKILL.md, parse, validate, embed, store.
//   5. Persist subscription record with ref_resolved = the hash.

import type { FileBank, Subscription } from "../lib/bank.js";
import type { EmbeddingProvider } from "../lib/embed.js";
import { composeEmbeddingText } from "../lib/embed.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseSkillSource } from "../lib/parse-skill.js";
import { validateSkill } from "../lib/validate.js";
import {
  enforceVerification,
  verifyGitHubTag,
  type SignatureStatus,
  type SignatureVerification,
} from "../lib/signature.js";

export interface SyncOptions {
  /**
   * Source spec, either:
   *   - `<host>/<owner>/<repo>` — uses default branch
   *   - `<host>/<owner>/<repo>@<ref>` — uses given ref
   */
  source: string;
  bank: FileBank;
  embedder: EmbeddingProvider;
  /** Optional fetch override for tests. */
  fetchFn?: typeof fetch;
  /**
   * Maximum skills to fetch+embed concurrently. Default: 4.
   *
   * Why 4: a small enough fan-out to stay polite to GitHub/jsDelivr and the
   * embedding provider, but large enough to cut wall-clock time by ~3-4× on
   * realistic packs (7 skills × ~12s per skill end-to-end → ~25s instead
   * of ~84s). Set to 1 to force sequential. Cloudflare/OpenAI handle this
   * fine; Ollama serializes per-model internally so concurrency doesn't help
   * there but doesn't hurt either.
   */
  concurrency?: number;
  /**
   * If true, require a verified-signed annotated tag at sync time. The sync
   * aborts (CliError, exit 5) when the signature is missing, invalid, or the
   * host doesn't expose verification.
   *
   * Default: false (signature status is recorded in provenance but not
   * enforced). v0.10.0+.
   */
  verifySignature?: boolean;
}

export interface SyncSkillResult {
  id: string;
  identity?: string;
  status: "synced" | "invalid" | "error";
  message?: string;
  errors?: Array<{ path: string; message: string }>;
}

export interface SyncResult {
  source: string;
  ref_requested: string;
  ref_resolved: string;
  skills: SyncSkillResult[];
  total: number;
  synced: number;
  invalid: number;
  errored: number;
  /**
   * Signature verification result for the resolved tag (v0.10.0+).
   * Always populated for github.com hosts even when --verify-signature is
   * off. status="unverified" for non-GitHub hosts and raw-SHA refs.
   */
  signature?: SignatureVerification;
  /** True iff --verify-signature was requested AND verification passed. */
  signature_enforced?: boolean;
}

interface SkillsIndexEntry {
  id: string;
  version: string;
  url: string;
  summary?: string;
}

interface SkillsIndex {
  schema_version: string;
  publisher?: { name?: string; domain?: string; github_org?: string };
  default_source?: { type?: string; repo?: string; default_branch?: string };
  url_template?: string;
  skills: SkillsIndexEntry[];
}

const parseSourceSpec = (
  source: string,
): { repo: string; refRequested: string } => {
  const at = source.indexOf("@");
  if (at < 0) {
    return { repo: source, refRequested: "main" };
  }
  return {
    repo: source.slice(0, at),
    refRequested: source.slice(at + 1),
  };
};

/**
 * Resolve a ref (tag, branch, hash) to a 40-character commit hash via the
 * host's REST API. Currently supports GitHub; extend for GitLab / Bitbucket.
 *
 * Returns the SHA. Throws CliError on resolution failure.
 */
export const resolveRef = async (
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
): Promise<string> => {
  // If ref looks like a 40+ hex hash already, use it directly.
  if (/^[a-f0-9]{40,}$/.test(ref)) {
    return ref;
  }

  if (!repo.startsWith("github.com/")) {
    throw new CliError(
      EXIT.USAGE,
      `cannot resolve refs for non-GitHub host '${repo}' yet — supply a 40-hex commit hash directly, or open an issue requesting GitLab/Bitbucket support`,
    );
  }

  const ownerRepo = repo.slice("github.com/".length);

  // Try as tag first, then as commit/branch.
  const candidates = [
    `https://api.github.com/repos/${ownerRepo}/git/refs/tags/${ref}`,
    `https://api.github.com/repos/${ownerRepo}/commits/${ref}`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as
        | { object?: { sha?: string } }
        | { sha?: string };
      const sha = (json as { object?: { sha?: string } }).object?.sha
        ?? (json as { sha?: string }).sha;
      if (typeof sha === "string" && /^[a-f0-9]{40,}$/.test(sha)) {
        return sha;
      }
    } catch {
      // try next
    }
  }

  throw new CliError(
    EXIT.NOT_FOUND,
    `cannot resolve ref '${ref}' for repo '${repo}' — tag not found, commit not found, or unauthenticated rate limit hit`,
  );
};

const buildSkillsIndexUrl = (repo: string, sha: string): string => {
  if (!repo.startsWith("github.com/")) {
    throw new CliError(EXIT.USAGE, `unsupported host: ${repo}`);
  }
  const ownerRepo = repo.slice("github.com/".length);
  return `https://cdn.jsdelivr.net/gh/${ownerRepo}@${sha}/skills-index.json`;
};

const renderUrlFromTemplate = (
  template: string,
  ctx: { ref: string; path: string },
): string => template.replace(/\{ref\}/g, ctx.ref).replace(/\{path\}/g, ctx.path);

export const runSync = async (opts: SyncOptions): Promise<SyncResult> => {
  const { source, bank, embedder } = opts;
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;

  // 1. Parse source
  const { repo, refRequested } = parseSourceSpec(source);

  // 2. Resolve ref → commit hash
  const sha = await resolveRef(repo, refRequested, fetchImpl);

  // 2.5. Verify the tag's signature (always observe; optionally enforce).
  //      For non-GitHub hosts and raw-SHA refs the verifier returns
  //      status="unverified" without making an API call.
  const signature = await verifyGitHubTag(repo, refRequested, fetchImpl);
  if (opts.verifySignature === true) {
    enforceVerification(signature, repo, refRequested);
  }

  // 3. Initialize bank metadata (idempotent; refuses model mismatch)
  await bank.initMeta({
    embedding_model: embedder.name,
    embedding_dim: embedder.dim,
  });

  // 4. Fetch skills-index.json
  const indexUrl = buildSkillsIndexUrl(repo, sha);
  let index: SkillsIndex;
  try {
    const res = await fetchImpl(indexUrl);
    if (!res.ok) {
      throw new CliError(
        EXIT.NOT_FOUND,
        `cannot fetch skills-index.json (${res.status} ${res.statusText}): ${indexUrl}`,
      );
    }
    index = (await res.json()) as SkillsIndex;
  } catch (err) {
    if (err instanceof CliError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `failed to fetch skills-index.json: ${msg}`);
  }

  if (!Array.isArray(index.skills)) {
    throw new CliError(
      EXIT.VALIDATION,
      `skills-index.json at ${indexUrl} is missing 'skills' array`,
    );
  }

  // 5. Ingest skills with bounded concurrency. Results preserve index.skills order
  //    regardless of completion order — UX wants the same listing every run.
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: SyncSkillResult[] = new Array(index.skills.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= index.skills.length) return;
      const entry = index.skills[i] as SkillsIndexEntry;
      results[i] = await syncSingleSkill({
        entry,
        repo,
        sha,
        urlTemplate: index.url_template,
        bank,
        embedder,
        fetchImpl,
        refRequested,
        signatureStatus: signature.status,
        signedBy: signature.signed_by,
        signatureMethod: signature.method,
      });
    }
  };
  const n = Math.min(concurrency, index.skills.length);
  await Promise.all(Array.from({ length: n }, () => worker()));

  // 6. Persist subscription
  const subscription: Subscription = {
    id: source,
    source_type: "git",
    repo,
    ref_requested: refRequested,
    ref_resolved: sha,
    auto_update: false,
    last_synced: new Date().toISOString(),
    ...(opts.verifySignature === true ? { verify_signature: true } : {}),
  };
  await bank.upsertSubscription(subscription);

  return {
    source,
    ref_requested: refRequested,
    ref_resolved: sha,
    skills: results,
    total: results.length,
    synced: results.filter((r) => r.status === "synced").length,
    invalid: results.filter((r) => r.status === "invalid").length,
    errored: results.filter((r) => r.status === "error").length,
    signature,
    signature_enforced: opts.verifySignature === true && signature.status === "valid",
  };
};

const syncSingleSkill = async (params: {
  entry: SkillsIndexEntry;
  repo: string;
  sha: string;
  urlTemplate?: string;
  bank: FileBank;
  embedder: EmbeddingProvider;
  fetchImpl: typeof fetch;
  refRequested: string;
  signatureStatus: SignatureStatus;
  signedBy?: string;
  signatureMethod?: "gpg" | "ssh" | "sigstore";
}): Promise<SyncSkillResult> => {
  const { entry, repo, sha, urlTemplate, bank, embedder, fetchImpl, refRequested, signatureStatus, signedBy, signatureMethod } = params;

  const url = entry.url
    ?? (urlTemplate
      ? renderUrlFromTemplate(urlTemplate, { ref: sha, path: entry.id })
      : null);
  if (!url) {
    return {
      id: entry.id,
      status: "error",
      message: `no URL for skill (neither entry.url nor index.url_template provided)`,
    };
  }

  let skillSource: string;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return {
        id: entry.id,
        status: "error",
        message: `fetch failed (${res.status} ${res.statusText}): ${url}`,
      };
    }
    skillSource = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: entry.id, status: "error", message: `fetch threw: ${msg}` };
  }

  let parsed;
  try {
    parsed = parseSkillSource(skillSource);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: entry.id, status: "error", message: `parse failed: ${msg}` };
  }

  const validation = validateSkill(parsed.frontmatter);
  if (!validation.valid) {
    return { id: entry.id, status: "invalid", errors: validation.errors };
  }

  const fm = parsed.frontmatter;

  // Compose embedding text per SPEC §4.2 and embed
  const embedText = composeEmbeddingText(fm);
  let embedding: number[];
  try {
    embedding = await embedder.embed(embedText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: entry.id, status: "error", message: `embedding failed: ${msg}` };
  }

  // Compute identity per SPEC §1
  const identity = `${repo}@${sha}/${entry.id}`;
  const now = new Date().toISOString();

  await bank.upsertSkill({
    ...fm,
    identity,
    provenance: {
      source_type: "git",
      source: repo,
      ref_resolved_to: sha,
      ref_requested: refRequested,
      fetched_at: now,
      signature_status: signatureStatus,
      ...(signedBy !== undefined ? { signed_by: signedBy } : {}),
      ...(signatureMethod !== undefined ? { signature_method: signatureMethod } : {}),
    },
    embedding,
    embedding_model: embedder.name,
    inserted_at: now,
    updated_at: now,
  });

  return { id: entry.id, identity, status: "synced" };
};
