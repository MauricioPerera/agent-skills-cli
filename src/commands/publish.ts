// `agent-skills publish [<dir>]` — author tooling for skill packs.
//
// What it does:
//   1. Scans <dir>/skills/<id>/SKILL.md, parses + validates each.
//   2. Composes <dir>/skills-index.json:
//        - publisher / default_source / url_template come from the existing
//          index (if any) or from --repo / --branch / --release flags.
//        - skills[] is generated from the disk; summary defaults to the SKILL.md
//          `description` but a hand-crafted summary in the existing index is
//          preserved on re-publish.
//   3. Optionally creates a git tag with --tag <version> (signed with --sign).
//
// Design choices:
//   - Idempotent: running publish twice on an unchanged tree yields a byte-
//     identical index file. No timestamps written. Reproducible builds matter.
//   - Author-edits-preserved: hand-crafted summaries in the existing index
//     stay; only newly-added skills get their summary auto-generated from
//     description. Author can re-edit and re-publish.
//   - Fail-fast on validation errors. The whole point is "make sure your pack
//     is correct BEFORE you tag a release".
//   - --check-only validates without writing or tagging — for CI integration.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseSkillSource } from "../lib/parse-skill.js";
import { validateSkill, type ValidationError } from "../lib/validate.js";
import { CliError, EXIT } from "../lib/errors.js";

export interface PublishOptions {
  /** Root of the pack — must contain skills/ and (optionally) skills-index.json. Default: "." */
  dir?: string;
  /** Don't write the index or create a tag, just validate. Default: false. */
  checkOnly?: boolean;
  /**
   * Override `default_source.repo` and the host for url_template inference.
   * Format: `<host>/<owner>/<repo>` (e.g., `github.com/me/my-pack`).
   * Used only on first publish (when no existing index supplies it).
   */
  repo?: string;
  /**
   * Default branch for `default_source.default_branch`. Default: "main".
   * Used only on first publish.
   */
  branch?: string;
  /**
   * Released ref to embed in each skill's resolved URL (e.g., "v1.0.0").
   * If omitted, uses the existing index's `latest_release` field, else the
   * resolved URL is omitted (clients fall back to url_template).
   */
  ref?: string;
  /** Publisher name — first publish only. */
  publisherName?: string;
  /** Create a git tag at HEAD with this version (e.g., "v1.0.1"). */
  tag?: string;
  /** Sign the git tag (`git tag -s`). Requires GPG configured. */
  sign?: boolean;
}

export interface PublishSkillResult {
  id: string;
  /** Path on disk (relative to dir). */
  path: string;
  version: string;
  /**
   * - "added":     skill is on disk but wasn't in the existing index
   * - "updated":   skill changed (different version or summary)
   * - "unchanged": skill matches the existing index byte-for-byte
   * - "invalid":   SKILL.md fails validation (publish refuses to write)
   * - "error":     parse or read error
   */
  status: "added" | "updated" | "unchanged" | "invalid" | "error";
  errors?: ValidationError[];
  message?: string;
}

export interface PublishResult {
  dir: string;
  index_path: string;
  /** True iff the index file changed (or would change in --check-only mode). */
  index_changed: boolean;
  /** True iff publish wrote the index to disk this run. */
  index_written: boolean;
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  invalid: number;
  errored: number;
  /** Skill ids that exist in the existing index but no longer on disk. */
  removed: string[];
  skills: PublishSkillResult[];
  /** If --tag was set and creation succeeded. */
  git_tag?: string;
}

interface ExistingSkillEntry {
  id: string;
  version?: string;
  url?: string;
  summary?: string;
}

interface ExistingIndex {
  schema_version?: string;
  publisher?: Record<string, unknown>;
  default_source?: Record<string, unknown>;
  url_template?: string;
  skills?: ExistingSkillEntry[];
}

/** Parse an existing skills-index.json if present. Tolerates absence or partial fields. */
const readExistingIndex = async (path: string): Promise<ExistingIndex | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `cannot read ${path}: ${msg}`);
  }
  try {
    return JSON.parse(text) as ExistingIndex;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      EXIT.VALIDATION,
      `${path} is not valid JSON: ${msg}. Fix or delete it before re-publishing.`,
    );
  }
};

/** Best-effort URL template inference. Falls back to a placeholder requiring author edit. */
const inferUrlTemplate = (repo: string | undefined): string | undefined => {
  if (!repo) return undefined;
  if (repo.startsWith("github.com/")) {
    const ownerRepo = repo.slice("github.com/".length);
    return `https://cdn.jsdelivr.net/gh/${ownerRepo}@{ref}/skills/{path}/SKILL.md`;
  }
  if (repo.startsWith("gitlab.com/")) {
    const ownerRepo = repo.slice("gitlab.com/".length);
    return `https://gitlab.com/${ownerRepo}/-/raw/{ref}/skills/{path}/SKILL.md`;
  }
  return undefined;
};

const renderUrl = (
  template: string | undefined,
  ref: string | undefined,
  skillId: string,
): string | undefined => {
  if (!template || !ref) return undefined;
  return template.replace(/\{ref\}/g, ref).replace(/\{path\}/g, skillId);
};

interface ComposedIndexSkill {
  id: string;
  version: string;
  url?: string;
  summary?: string;
}

interface ComposedIndex {
  schema_version: "0.1";
  publisher?: Record<string, unknown>;
  default_source?: Record<string, unknown>;
  url_template?: string;
  skills: ComposedIndexSkill[];
}

const exec = (
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exit_code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    proc.on("close", (code) => resolve({ exit_code: code ?? 1, stdout, stderr }));
    proc.on("error", (err) =>
      resolve({ exit_code: 1, stdout: "", stderr: `spawn error: ${err.message}` }),
    );
  });

export const runPublish = async (opts: PublishOptions): Promise<PublishResult> => {
  const dir = opts.dir ?? ".";
  const skillsDir = join(dir, "skills");
  const indexPath = join(dir, "skills-index.json");
  const branch = opts.branch ?? "main";

  // 1. Read existing index (if any) — preserves publisher metadata and hand-crafted summaries.
  const existing = await readExistingIndex(indexPath);
  const existingSkillsById = new Map<string, ExistingSkillEntry>();
  if (existing?.skills) {
    for (const s of existing.skills) {
      if (typeof s.id === "string") existingSkillsById.set(s.id, s);
    }
  }

  // 2. Discover skills/<dir>/SKILL.md.
  let dirEntries: string[];
  try {
    dirEntries = await readdir(skillsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(
        EXIT.NOT_FOUND,
        `${skillsDir} does not exist. publish expects a 'skills/' subdirectory ` +
          `containing one folder per skill, each with a SKILL.md.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `cannot read ${skillsDir}: ${msg}`);
  }

  // 3. Parse + validate each skill.
  //
  //   Iteration order matters: we use it as the order skills appear in the
  //   resulting index. Strategy:
  //     a. First, walk the existing-index order — preserves any curated
  //        ordering the author has hand-set (e.g., feature-discoverability
  //        order rather than alphabetical).
  //     b. Then walk anything new (on disk but not in the index), sorted
  //        alphabetically among themselves so re-publishes are deterministic.
  //
  //   This makes `publish` a no-op on unchanged trees even when the existing
  //   index isn't in alphabetical order.
  const skillResults: PublishSkillResult[] = [];
  const onDiskIds = new Set<string>();
  const onDiskSet = new Set(dirEntries);
  const orderedEntries: string[] = [];
  const seen = new Set<string>();
  // a. Existing-index order, filtered to what's on disk
  if (existing?.skills) {
    for (const s of existing.skills) {
      if (typeof s.id === "string" && onDiskSet.has(s.id) && !seen.has(s.id)) {
        orderedEntries.push(s.id);
        seen.add(s.id);
      }
    }
  }
  // b. New entries sorted alphabetically
  for (const entry of [...dirEntries].sort()) {
    if (!seen.has(entry)) {
      orderedEntries.push(entry);
      seen.add(entry);
    }
  }

  for (const entry of orderedEntries) {
    const skillMdPath = join(skillsDir, entry, "SKILL.md");
    let source: string;
    try {
      source = await readFile(skillMdPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // not a skill dir
      const msg = err instanceof Error ? err.message : String(err);
      skillResults.push({ id: entry, path: skillMdPath, version: "", status: "error", message: `read error: ${msg}` });
      continue;
    }

    let parsed;
    try {
      parsed = parseSkillSource(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skillResults.push({ id: entry, path: skillMdPath, version: "", status: "error", message: `parse error: ${msg}` });
      continue;
    }

    if (!parsed.frontmatter || !parsed.body) {
      skillResults.push({
        id: entry,
        path: skillMdPath,
        version: "",
        status: "error",
        message: "SKILL.md missing frontmatter or body",
      });
      continue;
    }

    const fm = parsed.frontmatter;
    const validation = validateSkill(fm);
    if (!validation.valid) {
      skillResults.push({
        id: typeof fm.id === "string" ? fm.id : entry,
        path: skillMdPath,
        version: typeof fm.version === "string" ? fm.version : "",
        status: "invalid",
        errors: validation.errors,
      });
      continue;
    }

    // Cross-check: directory name should match `id` (a soft warning condition;
    // we don't fail on mismatch but we record the disk path).
    onDiskIds.add(fm.id);

    // Compose the index entry for this skill.
    const repo = opts.repo
      ?? (typeof existing?.default_source?.["repo"] === "string"
        ? (existing.default_source["repo"] as string)
        : undefined);
    const ref = opts.ref
      ?? (typeof existing?.default_source?.["latest_release"] === "string"
        ? (existing.default_source["latest_release"] as string)
        : undefined);
    const urlTemplate = existing?.url_template ?? inferUrlTemplate(repo);
    const url = renderUrl(urlTemplate, ref, fm.id);

    // Summary: prefer existing hand-crafted summary; fall back to description.
    const existingEntry = existingSkillsById.get(fm.id);
    const summary = existingEntry?.summary ?? fm.description;

    // Determine added/updated/unchanged.
    let status: PublishSkillResult["status"] = "unchanged";
    if (!existingEntry) {
      status = "added";
    } else {
      const changed =
        existingEntry.version !== fm.version
        || existingEntry.url !== url
        || existingEntry.summary !== summary;
      status = changed ? "updated" : "unchanged";
    }

    skillResults.push({
      id: fm.id,
      path: skillMdPath,
      version: fm.version,
      status,
    });
  }

  // 4. Figure out removals (in existing index but no longer on disk).
  const removed: string[] = [];
  for (const id of existingSkillsById.keys()) {
    if (!onDiskIds.has(id)) removed.push(id);
  }
  removed.sort();

  // 5. Compose the new index — only if every skill validated.
  const hasFailures = skillResults.some(
    (s) => s.status === "invalid" || s.status === "error",
  );

  let composed: ComposedIndex | null = null;
  let indexChanged = false;
  let indexWritten = false;

  if (!hasFailures) {
    const validResults = skillResults.filter(
      (s) => s.status !== "invalid" && s.status !== "error",
    );

    // Publisher: existing wins, else build from flags.
    let publisher: Record<string, unknown> | undefined = existing?.publisher;
    if (publisher === undefined) {
      publisher = {};
      if (opts.publisherName) (publisher as Record<string, unknown>)["name"] = opts.publisherName;
      // Keep object empty rather than undefined so authors see it as "needs editing"
      // rather than missing entirely.
    }

    // default_source: fold flags over existing.
    const defaultSource: Record<string, unknown> = {
      type: "git",
      ...(existing?.default_source ?? {}),
    };
    if (opts.repo) defaultSource["repo"] = opts.repo;
    if (opts.branch) defaultSource["default_branch"] = branch;
    if (opts.ref) defaultSource["latest_release"] = opts.ref;

    const repoForTemplate = opts.repo
      ?? (typeof defaultSource["repo"] === "string" ? (defaultSource["repo"] as string) : undefined);
    const urlTemplate = existing?.url_template ?? inferUrlTemplate(repoForTemplate);
    const refForUrl = opts.ref
      ?? (typeof defaultSource["latest_release"] === "string"
        ? (defaultSource["latest_release"] as string)
        : undefined);

    composed = {
      schema_version: "0.1",
      ...(Object.keys(publisher).length > 0 ? { publisher } : {}),
      ...(Object.keys(defaultSource).length > 1 ? { default_source: defaultSource } : {}), // > 1 because we always have type
      ...(urlTemplate ? { url_template: urlTemplate } : {}),
      skills: validResults.map((r) => {
        // Re-resolve summary against existing (hand-crafted preserved).
        const existingEntry = existingSkillsById.get(r.id);
        const url = renderUrl(urlTemplate, refForUrl, r.id);
        // We need the description for the fallback summary — re-read once.
        // (The earlier loop didn't store description in the result; fine —
        // rare path, and we have the path in r.path.)
        return {
          id: r.id,
          version: r.version,
          ...(url !== undefined ? { url } : {}),
          ...(existingEntry?.summary !== undefined ? { summary: existingEntry.summary } : {}),
        };
      }),
    };

    // Fill summary fallback for new skills: re-read description from disk.
    for (let i = 0; i < composed.skills.length; i++) {
      const s = composed.skills[i] as ComposedIndexSkill;
      if (s.summary === undefined) {
        const r = validResults[i] as PublishSkillResult;
        try {
          const src = await readFile(r.path, "utf8");
          const parsed = parseSkillSource(src);
          if (parsed.frontmatter && typeof parsed.frontmatter.description === "string") {
            s.summary = parsed.frontmatter.description;
          }
        } catch {
          // best effort
        }
      }
    }

    // Compare with existing for indexChanged.
    const existingSerialized = existing ? JSON.stringify(existing) : "";
    const composedSerialized = JSON.stringify(composed);
    indexChanged = existingSerialized !== composedSerialized;

    // 6. Write (unless --check-only).
    if (indexChanged && opts.checkOnly !== true) {
      await writeFile(indexPath, JSON.stringify(composed, null, 2) + "\n", "utf8");
      indexWritten = true;
    }
  }

  // 7. Optionally create a git tag.
  let gitTag: string | undefined;
  if (
    opts.tag !== undefined
    && !hasFailures
    && opts.checkOnly !== true
  ) {
    const args = ["tag"];
    if (opts.sign === true) args.push("-s");
    args.push("-a", opts.tag, "-m", `Release ${opts.tag}`);
    const result = await exec("git", args, dir);
    if (result.exit_code !== 0) {
      throw new CliError(
        EXIT.RUNTIME,
        `git tag failed (exit ${result.exit_code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    gitTag = opts.tag;
  }

  const counts = {
    total: skillResults.length,
    added: skillResults.filter((s) => s.status === "added").length,
    updated: skillResults.filter((s) => s.status === "updated").length,
    unchanged: skillResults.filter((s) => s.status === "unchanged").length,
    invalid: skillResults.filter((s) => s.status === "invalid").length,
    errored: skillResults.filter((s) => s.status === "error").length,
  };

  return {
    dir,
    index_path: indexPath,
    index_changed: indexChanged,
    index_written: indexWritten,
    ...counts,
    removed,
    skills: skillResults,
    ...(gitTag !== undefined ? { git_tag: gitTag } : {}),
  };
};

const STATUS_GLYPH: Record<PublishSkillResult["status"], string> = {
  added: "+",
  updated: "↑",
  unchanged: "·",
  invalid: "✗",
  error: "!",
};

export const printPublishResult = (result: PublishResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`Publish ${result.total} skill(s) from ${result.dir}\n\n`);
  for (const s of result.skills) {
    const glyph = STATUS_GLYPH[s.status];
    process.stdout.write(`  ${glyph} ${s.id.padEnd(28)} ${s.version || "—"}`);
    if (s.status === "added" || s.status === "updated") {
      process.stdout.write(`  (${s.status})`);
    }
    process.stdout.write("\n");
    if (s.errors) {
      for (const e of s.errors) process.stdout.write(`      ${e.path}: ${e.message}\n`);
    }
    if (s.message) process.stdout.write(`      ${s.message}\n`);
  }

  if (result.removed.length > 0) {
    process.stdout.write(`\n  Removed (in old index, not on disk):\n`);
    for (const id of result.removed) process.stdout.write(`    - ${id}\n`);
  }

  process.stdout.write(`\n`);
  if (result.invalid + result.errored > 0) {
    process.stdout.write(
      `✗ ${result.invalid} invalid, ${result.errored} errored. ` +
        `Fix and re-run.\n`,
    );
  } else {
    process.stdout.write(
      `summary: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged`,
    );
    if (result.removed.length > 0) process.stdout.write(`, ${result.removed.length} removed`);
    process.stdout.write("\n");
    if (result.index_written) {
      process.stdout.write(`✓ wrote ${result.index_path}\n`);
    } else if (result.index_changed) {
      process.stdout.write(`(would write ${result.index_path}; --check-only is on)\n`);
    } else {
      process.stdout.write(`✓ ${result.index_path} already up-to-date\n`);
    }
    if (result.git_tag) {
      process.stdout.write(`✓ git tag ${result.git_tag}\n`);
      process.stdout.write(`  next: git push origin ${result.git_tag}\n`);
    }
  }
};
