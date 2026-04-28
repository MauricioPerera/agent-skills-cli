// Tag-signature verification at sync time (v0.10.0+).
//
// Threat model (per SECURITY.md): when a bank fetches a SKILL.md from a CDN
// at a resolved commit hash, the resolution path passes through:
//   user-supplied ref (tag) → host's API → commit SHA → CDN URL
// If an attacker compromises the host (e.g., a stolen GitHub account) they
// can move a tag to point at a malicious commit, the bank fetches the new
// content, and the agent runs it. Defence: verify that the tag itself was
// signed by a key the publisher controls, and the host vouches for that key.
//
// For github.com the host runs GPG verification server-side and exposes the
// result via the API. We use that. The trust assumption is "GitHub correctly
// vetted the signing key against the publisher's GitHub account" — the same
// trust assumption you make when you read `gh pr` or trust GitHub-hosted
// branch protection. For higher-trust deployments (per SECURITY.md), v0.11+
// will add client-side GPG with a `trusted_keys` allowlist on the
// subscription.
//
// Two-tier deployment of verification:
//   1. Always observe: every sync calls verifyGitHubTag and records the result
//      in provenance.signature_status. Free, even when the user didn't ask
//      for verification.
//   2. Optionally enforce: --verify-signature flag (or subscription's
//      verify_signature: true) makes the sync abort with a CliError when
//      status !== "valid". Default off so existing setups keep working.

import { CliError, EXIT } from "./errors.js";

/**
 * Result of a single tag's signature verification.
 *
 *   - "valid"     — signature present, verified by host's GPG check.
 *   - "invalid"   — signature present BUT host couldn't verify (unknown key,
 *                   bad email, expired key, etc.). Treat as untrusted.
 *   - "unsigned"  — no signature on the tag.
 *   - "unverified" — verification couldn't be attempted (non-GitHub host,
 *                   lightweight tag with no tag object, ref is a raw SHA, etc.).
 */
export type SignatureStatus = "valid" | "invalid" | "unsigned" | "unverified";

export interface SignatureVerification {
  status: SignatureStatus;
  /** Free-text reason from the host (e.g., "unsigned", "unknown_key", "valid"). */
  reason: string;
  /** Tagger's identity if the host exposes it. Useful for audit display. */
  signed_by?: string;
}

interface GitHubTagObject {
  tag?: string;
  message?: string;
  tagger?: { name?: string; email?: string };
  verification?: {
    verified?: boolean;
    reason?: string;
    signature?: string | null;
    payload?: string | null;
  };
}

interface GitHubRefObject {
  ref?: string;
  object?: { sha?: string; type?: "tag" | "commit"; url?: string };
}

/**
 * Verify a tag's signature via GitHub's REST API.
 *
 * `ref` is the user-supplied tag name (e.g., "v1.0.0"). `repo` is in the
 * `github.com/<owner>/<repo>` form. Returns "unverified" for non-GitHub
 * hosts and lightweight tags. Never throws on legitimate API responses;
 * only throws on unexpected JSON or transport failure.
 */
export const verifyGitHubTag = async (
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
): Promise<SignatureVerification> => {
  // Non-GitHub hosts: punt to v0.11+ (GitLab/Bitbucket APIs differ).
  if (!repo.startsWith("github.com/")) {
    return { status: "unverified", reason: `host '${repo}' not supported by GPG verifier yet` };
  }

  // Raw SHAs: no tag-level signature to inspect. We could verify the
  // *commit* signature instead, but that's a different semantic (the
  // attacker would need to forge a commit, not move a tag) and out of
  // scope for this release.
  if (/^[a-f0-9]{40,}$/.test(ref)) {
    return { status: "unverified", reason: "ref is a raw commit hash; no tag-level signature to verify" };
  }

  const ownerRepo = repo.slice("github.com/".length);
  const refUrl = `https://api.github.com/repos/${ownerRepo}/git/refs/tags/${encodeURIComponent(ref)}`;

  let refRes: Response;
  try {
    refRes = await fetchImpl(refUrl, { headers: { Accept: "application/vnd.github+json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `signature verification: GitHub API request failed: ${msg}`);
  }
  if (refRes.status === 404) {
    // Caller resolved the ref already, but maybe via a branch or some other path.
    // Without a tag, there's nothing to verify.
    return { status: "unverified", reason: `tag '${ref}' not found via GitHub API` };
  }
  if (!refRes.ok) {
    return { status: "unverified", reason: `GitHub API returned ${refRes.status} ${refRes.statusText}` };
  }

  const refObj = (await refRes.json()) as GitHubRefObject;
  const objType = refObj.object?.type;
  const objSha = refObj.object?.sha;

  if (objType === "commit") {
    // Lightweight tag: points directly at a commit, has no tag object,
    // therefore no tag-level signature. (You can sign the commit instead,
    // but `git tag -s` only signs annotated tags.)
    return { status: "unsigned", reason: "lightweight tag (annotated tag required for tag-signing)" };
  }
  if (objType !== "tag" || typeof objSha !== "string") {
    return { status: "unverified", reason: "unexpected GitHub API ref shape (no tag object)" };
  }

  // Annotated tag. Fetch the tag object for the verification field.
  const tagUrl = `https://api.github.com/repos/${ownerRepo}/git/tags/${objSha}`;
  let tagRes: Response;
  try {
    tagRes = await fetchImpl(tagUrl, { headers: { Accept: "application/vnd.github+json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `signature verification: GitHub API request failed: ${msg}`);
  }
  if (!tagRes.ok) {
    return { status: "unverified", reason: `tag-object fetch returned ${tagRes.status} ${tagRes.statusText}` };
  }

  const tagObj = (await tagRes.json()) as GitHubTagObject;
  const verification = tagObj.verification;
  const taggerEmail = tagObj.tagger?.email;
  const taggerName = tagObj.tagger?.name;
  const signedBy = taggerName || taggerEmail
    ? `${taggerName ?? ""}${taggerName && taggerEmail ? " " : ""}${taggerEmail ? `<${taggerEmail}>` : ""}`.trim()
    : undefined;

  if (!verification) {
    return {
      status: "unverified",
      reason: "GitHub returned no verification block",
      ...(signedBy !== undefined ? { signed_by: signedBy } : {}),
    };
  }

  const reason = verification.reason ?? "unknown";

  if (verification.verified === true) {
    return {
      status: "valid",
      reason,
      ...(signedBy !== undefined ? { signed_by: signedBy } : {}),
    };
  }

  // verified === false. Distinguish "no signature was attempted" from "signature
  // present but couldn't be verified".
  if (reason === "unsigned" || verification.signature === null || verification.signature === undefined) {
    return {
      status: "unsigned",
      reason,
      ...(signedBy !== undefined ? { signed_by: signedBy } : {}),
    };
  }

  return {
    status: "invalid",
    reason,
    ...(signedBy !== undefined ? { signed_by: signedBy } : {}),
  };
};

/**
 * Helper: throw a CliError if enforcement is on and the status isn't "valid".
 * Used by sync to gate ingestion.
 */
export const enforceVerification = (
  result: SignatureVerification,
  repo: string,
  ref: string,
): void => {
  if (result.status === "valid") return;
  const detail = result.signed_by
    ? ` (tagger: ${result.signed_by}, reason: ${result.reason})`
    : ` (reason: ${result.reason})`;
  throw new CliError(
    EXIT.VALIDATION,
    `signature verification failed for ${repo}@${ref}: status=${result.status}${detail}. ` +
      `Pass without --verify-signature to ingest unverified, or work with the publisher to ` +
      `sign their tag with 'git tag -s' and re-tag.`,
  );
};
