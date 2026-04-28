// `agent-skills update [<source>] [--all] [--dry-run]` — refresh subscribed
// packs from upstream.
//
// What problem this solves:
//   - sync <repo>@<ref> always ADDS at the resolved SHA. If the SHA changes
//     (e.g., a moving branch ref like @main, or a force-pushed tag), older
//     SHAs accumulate as orphan files in skills/. There's no garbage
//     collection.
//   - There's no batched ""refresh everything I'm subscribed to"" UX. The
//     user has to remember each `sync <repo>@<ref>` invocation.
//
// What update does:
//   1. List subscriptions in the bank.
//   2. For each (or for the one named on the CLI):
//      a. Re-resolve the subscribed ref → SHA via the host's API.
//      b. Compare to the recorded ref_resolved. If equal, ""up to date"" — skip.
//      c. Otherwise, re-run sync (which inherits the original
//         verify_signature setting from the subscription).
//      d. Compute a diff: skills added, removed, version-bumped.
//      e. Garbage-collect orphaned skills with stale SHAs from this source.
//   3. Report summary + per-subscription deltas.
//
// --dry-run resolves new SHAs and reports what WOULD change without writing.
//
// Pinned tags vs moving refs: this command treats both the same way. A
// pinned tag normally re-resolves to the same SHA → no-op. But if the
// publisher force-pushed the tag (or rotated it for a security patch),
// update picks that up. With --verify-signature persisted on the
// subscription, the re-sync will refuse to ingest the new SHA if its tag
// signature doesn't verify — so update can't be exploited to silently
// downgrade a verified pack.

import type { FileBank, IndexedSkill, Subscription } from "../lib/bank.js";
import type { EmbeddingProvider } from "../lib/embed.js";
import { CliError, EXIT } from "../lib/errors.js";
import { resolveRef, runSync, type SyncResult } from "./sync.js";

export interface UpdateOptions {
  bank: FileBank;
  embedder: EmbeddingProvider;
  /**
   * Specific subscription id (the source spec like `github.com/me/pack@v1.0.0`)
   * to update. Undefined = update all subscriptions.
   */
  source?: string;
  /** Resolve refs and report planned changes; don't re-sync, don't GC. */
  dryRun?: boolean;
  /** Optional fetch override for tests. */
  fetchFn?: typeof fetch;
}

export interface UpdateSubscriptionResult {
  /** The subscription id (also: the source spec). */
  source: string;
  ref_requested: string;
  /** The SHA the bank had recorded before this run. */
  ref_old: string;
  /** The SHA the host returns now. May equal ref_old. */
  ref_new: string;
  /** True iff ref_new !== ref_old AND we successfully re-synced (or dry-run says we would). */
  changed: boolean;
  /** Skills (short id) present after but not before. */
  added: string[];
  /** Skills (short id) present before but not after. */
  removed: string[];
  /** Skills with bumped version, formatted as ""<id>: <old> → <new>"". */
  updated: string[];
  /** Number of skills present in both versions with the same version. */
  unchanged: number;
  /** Number of orphan files (old-SHA) actually deleted. 0 in dry-run. */
  gc_removed: number;
  /**
   * Number of skills the GC pass DECLINED to delete because their SHA is
   * pinned by another active subscription on the same repo (v0.13.3+).
   * Surfaced so operators of multi-subscription setups can see when the
   * protect-set kicked in. 0 in single-subscription deployments.
   */
  gc_protected: number;
  /** Underlying sync result; omitted for unchanged or dry-run. */
  sync?: SyncResult;
  /** If something failed (resolve error, sync error), the message. */
  error?: string;
}

export interface UpdateResult {
  total: number;
  changed: number;
  unchanged: number;
  failed: number;
  /** True iff this run was --dry-run; when true, nothing was written. */
  dry_run: boolean;
  subscriptions: UpdateSubscriptionResult[];
}

/**
 * Filter all bank skills down to those that came from a given subscription's
 * source repo (regardless of which SHA they were synced from).
 */
const skillsForSource = (all: readonly IndexedSkill[], repo: string): IndexedSkill[] =>
  all.filter((s) => s.identity.startsWith(`${repo}@`));

/**
 * Run a single subscription's update cycle. Caller decides how to invoke
 * (loop or filtered).
 */
const updateOne = async (
  sub: Subscription,
  opts: UpdateOptions,
  fetchImpl: typeof fetch,
): Promise<UpdateSubscriptionResult> => {
  const { bank, embedder } = opts;
  const repo = sub.repo ?? "";
  const refRequested = sub.ref_requested ?? "main";
  const refOld = sub.ref_resolved ?? "";

  if (repo.length === 0) {
    return {
      source: sub.id,
      ref_requested: refRequested,
      ref_old: refOld,
      ref_new: "",
      changed: false,
      added: [],
      removed: [],
      updated: [],
      unchanged: 0,
      gc_removed: 0,
      gc_protected: 0,
      error: `subscription has no repo recorded; can't update`,
    };
  }

  // Snapshot OLD skills for this source (across all SHAs).
  const allBefore = await bank.listSkills();
  const beforeForSource = skillsForSource(allBefore, repo);
  // Build a short-id → skill map. If a skill exists at multiple SHAs because
  // earlier syncs left orphans, prefer the entry whose SHA matches the
  // subscription's recorded ref_resolved (the ""live"" version), and fall
  // back to the most recently inserted otherwise.
  const beforeByShortId = new Map<string, IndexedSkill>();
  for (const s of beforeForSource) {
    const existing = beforeByShortId.get(s.id);
    if (existing === undefined) {
      beforeByShortId.set(s.id, s);
      continue;
    }
    const existingIsLive = existing.provenance.ref_resolved_to === refOld;
    const sIsLive = s.provenance.ref_resolved_to === refOld;
    if (sIsLive && !existingIsLive) {
      beforeByShortId.set(s.id, s);
    } else if (sIsLive === existingIsLive && s.inserted_at > existing.inserted_at) {
      beforeByShortId.set(s.id, s);
    }
  }

  // Re-resolve the ref.
  let refNew: string;
  try {
    refNew = await resolveRef(repo, refRequested, fetchImpl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source: sub.id,
      ref_requested: refRequested,
      ref_old: refOld,
      ref_new: "",
      changed: false,
      added: [],
      removed: [],
      updated: [],
      unchanged: beforeForSource.length,
      gc_removed: 0,
      gc_protected: 0,
      error: `cannot resolve ref: ${msg}`,
    };
  }

  // No change → no-op (no GC, no embedding API calls, nothing to write).
  if (refNew === refOld) {
    return {
      source: sub.id,
      ref_requested: refRequested,
      ref_old: refOld,
      ref_new: refNew,
      changed: false,
      added: [],
      removed: [],
      updated: [],
      unchanged: beforeForSource.length,
      gc_removed: 0,
      gc_protected: 0,
    };
  }

  // Dry-run: don't sync, don't GC. We could fetch skills-index.json to
  // preview which skills would change, but that's adding cost; for v0.11.0
  // ""changed: yes"" is enough signal. Operators run without --dry-run for
  // the per-skill deltas.
  if (opts.dryRun === true) {
    return {
      source: sub.id,
      ref_requested: refRequested,
      ref_old: refOld,
      ref_new: refNew,
      changed: true,
      added: [],
      removed: [],
      updated: [],
      unchanged: beforeForSource.length,
      gc_removed: 0,
      gc_protected: 0,
    };
  }

  // Re-sync. Inherits the subscription's verify_signature flag — if the
  // subscription was created with --verify-signature, an unsigned/invalid
  // new tag will abort here without ingesting anything.
  let syncResult: SyncResult;
  try {
    syncResult = await runSync({
      source: `${repo}@${refRequested}`,
      bank,
      embedder,
      fetchFn: fetchImpl,
      verifySignature: sub.verify_signature === true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source: sub.id,
      ref_requested: refRequested,
      ref_old: refOld,
      ref_new: refNew,
      changed: false,
      added: [],
      removed: [],
      updated: [],
      unchanged: beforeForSource.length,
      gc_removed: 0,
      gc_protected: 0,
      error: `sync failed: ${msg}`,
    };
  }

  // Snapshot NEW skills for this source (now includes both old-SHA orphans
  // and new-SHA skills until we GC).
  const allAfter = await bank.listSkills();
  const newSkills = allAfter.filter((s) =>
    s.identity.startsWith(`${repo}@${refNew}/`),
  );
  const newByShortId = new Map(newSkills.map((s) => [s.id, s]));

  // Compute diff using short ids (the natural identity for ""same skill,
  // different version"").
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const [id, newSkill] of newByShortId) {
    const oldSkill = beforeByShortId.get(id);
    if (!oldSkill) {
      added.push(id);
    } else if (oldSkill.version !== newSkill.version) {
      updated.push(`${id}: ${oldSkill.version} → ${newSkill.version}`);
    }
  }
  for (const [id] of beforeByShortId) {
    if (!newByShortId.has(id)) removed.push(id);
  }
  added.sort();
  removed.sort();
  updated.sort();
  const unchangedCount = newSkills.length - added.length - updated.length;

  // Garbage-collect orphans (v0.13.0+, formerly issue #6 from the post-v0.11
  // code review): drop any skill from THIS source whose SHA is neither
  // the new SHA nor held by another active subscription targeting the
  // same repo at a different ref.
  //
  // The previous (pre-v0.13) implementation matched by `repo@` prefix
  // alone. That meant if the operator had two subscriptions to the same
  // repo at different refs (e.g., `pack@v1.0.0` AND `pack@main`),
  // updating either one would GC the other's skills. The skills would be
  // re-fetched on the next sync of the affected subscription, but the
  // intermediate state was visibly incorrect.
  //
  // Now: we collect every still-pinned SHA for this repo across ALL
  // subscriptions, and refuse to GC any of those.
  const allSubs = await bank.listSubscriptions();
  const protectedShas = new Set<string>();
  for (const otherSub of allSubs) {
    if (otherSub.repo === repo && otherSub.id !== sub.id && otherSub.ref_resolved) {
      protectedShas.add(otherSub.ref_resolved);
    }
  }
  let gcCount = 0;
  let gcProtected = 0;
  for (const skill of allAfter) {
    if (!skill.identity.startsWith(`${repo}@`)) continue;
    if (skill.identity.startsWith(`${repo}@${refNew}/`)) continue;
    // Don't drop this skill if another subscription pins the SHA.
    const skillSha = skill.provenance.ref_resolved_to;
    if (skillSha && protectedShas.has(skillSha)) {
      gcProtected += 1;
      continue;
    }
    const ok = await bank.removeSkill(skill.identity);
    if (ok) gcCount += 1;
  }

  return {
    source: sub.id,
    ref_requested: refRequested,
    ref_old: refOld,
    ref_new: refNew,
    changed: true,
    added,
    removed,
    updated,
    unchanged: unchangedCount,
    gc_removed: gcCount,
    gc_protected: gcProtected,
    sync: syncResult,
  };
};

export const runUpdate = async (opts: UpdateOptions): Promise<UpdateResult> => {
  const { bank } = opts;
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;
  const allSubs = await bank.listSubscriptions();

  let targets: Subscription[];
  if (opts.source !== undefined) {
    targets = allSubs.filter((s) => s.id === opts.source);
    if (targets.length === 0) {
      throw new CliError(
        EXIT.NOT_FOUND,
        `no subscription matches '${opts.source}'. Run 'agent-skills list' to see what's installed.`,
      );
    }
  } else {
    targets = allSubs;
  }

  if (targets.length === 0) {
    return {
      total: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
      dry_run: opts.dryRun === true,
      subscriptions: [],
    };
  }

  const subscriptions: UpdateSubscriptionResult[] = [];
  for (const sub of targets) {
    subscriptions.push(await updateOne(sub, opts, fetchImpl));
  }

  return {
    total: subscriptions.length,
    changed: subscriptions.filter((r) => r.changed).length,
    unchanged: subscriptions.filter((r) => !r.changed && r.error === undefined).length,
    failed: subscriptions.filter((r) => r.error !== undefined).length,
    dry_run: opts.dryRun === true,
    subscriptions,
  };
};

export const printUpdateResult = (result: UpdateResult, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (result.total === 0) {
    process.stdout.write("No subscriptions to update. Run 'agent-skills sync <repo>' first.\n");
    return;
  }

  const header = result.dry_run ? "(dry run)" : "";
  process.stdout.write(`Update ${result.total} subscription(s) ${header}\n\n`);

  for (const sub of result.subscriptions) {
    if (sub.error !== undefined) {
      process.stdout.write(`  ✗ ${sub.source}\n`);
      process.stdout.write(`      error: ${sub.error}\n`);
      continue;
    }
    if (!sub.changed) {
      process.stdout.write(`  · ${sub.source}\n`);
      process.stdout.write(`      ${sub.ref_old.slice(0, 12)} (no change)\n`);
      continue;
    }
    process.stdout.write(`  ↑ ${sub.source}\n`);
    process.stdout.write(
      `      ${sub.ref_old.slice(0, 12)} → ${sub.ref_new.slice(0, 12)}` +
        (result.dry_run ? " (would resync)" : "") +
        "\n",
    );
    for (const id of sub.added) process.stdout.write(`      + ${id}\n`);
    for (const desc of sub.updated) process.stdout.write(`      ↑ ${desc}\n`);
    for (const id of sub.removed) process.stdout.write(`      - ${id}\n`);
    if (sub.gc_removed > 0) {
      process.stdout.write(`      gc: removed ${sub.gc_removed} orphaned file(s)\n`);
    }
    if (sub.gc_protected > 0) {
      process.stdout.write(
        `      gc: protected ${sub.gc_protected} skill(s) pinned by another active subscription\n`,
      );
    }
  }

  process.stdout.write(`\nsummary: ${result.changed} changed, ${result.unchanged} unchanged`);
  if (result.failed > 0) process.stdout.write(`, ${result.failed} failed`);
  process.stdout.write("\n");
};
