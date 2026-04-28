// Skill identity parser per agent-skills SPEC.md §1.
//
// Identity format:  <source>@<ref>/<path>
//
// where:
//   - <source>: <host>/<owner>/<repo> (git) OR <host> alone (server-hosted)
//   - <ref>:    git commit hash (≥40 hex), git tag, or "latest"
//   - <path>:   slash-separated path components, each matching ^[a-zA-Z0-9_-]+$
//
// The first slash AFTER @<ref> separates source from path.

import { CliError, EXIT } from "./errors.js";

export type IdentityRefKind = "hash" | "tag" | "latest";

export interface ParsedIdentity {
  /** Original identity string. */
  raw: string;
  /** Either a git source (host/owner/repo) or server-hosted (host alone). */
  source: string;
  /** True if source is host/owner/repo (git); false for server-hosted (host alone). */
  isGit: boolean;
  host: string;
  owner?: string;
  repo?: string;
  ref: string;
  refKind: IdentityRefKind;
  /** Slash-separated path within the source. */
  path: string;
  pathSegments: string[];
}

const HEX_REF_RE = /^[a-f0-9]{40,}$/;
const TAG_REF_RE = /^[a-zA-Z0-9_.+-]+$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const classifyRef = (ref: string): IdentityRefKind => {
  if (ref === "latest") return "latest";
  if (HEX_REF_RE.test(ref)) return "hash";
  if (TAG_REF_RE.test(ref)) return "tag";
  throw new CliError(EXIT.USAGE, `invalid ref '${ref}': must be a hex hash (≥40 chars), a tag matching ^[a-zA-Z0-9_.+-]+$, or 'latest'`);
};

/**
 * Parse an identity string into its components.
 *
 * Throws CliError(EXIT.USAGE) on malformed input.
 */
export const parseIdentity = (raw: string): ParsedIdentity => {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CliError(EXIT.USAGE, "identity is empty");
  }
  const at = raw.indexOf("@");
  if (at < 0) {
    throw new CliError(EXIT.USAGE, `identity '${raw}' missing @<ref> separator`);
  }
  const sourcePart = raw.slice(0, at);
  const rest = raw.slice(at + 1);

  if (sourcePart.length === 0) {
    throw new CliError(EXIT.USAGE, `identity '${raw}' has empty source`);
  }
  if (rest.length === 0) {
    throw new CliError(EXIT.USAGE, `identity '${raw}' has empty ref + path`);
  }

  // First slash after @<ref> separates source from path.
  const firstSlash = rest.indexOf("/");
  if (firstSlash < 0) {
    throw new CliError(EXIT.USAGE, `identity '${raw}' missing path component after @<ref>`);
  }
  const ref = rest.slice(0, firstSlash);
  const path = rest.slice(firstSlash + 1);

  if (ref.length === 0) {
    throw new CliError(EXIT.USAGE, `identity '${raw}' has empty ref between @ and /`);
  }
  if (path.length === 0) {
    throw new CliError(EXIT.USAGE, `identity '${raw}' has empty path after first slash`);
  }

  const refKind = classifyRef(ref);

  // Validate path segments.
  const pathSegments = path.split("/");
  for (const seg of pathSegments) {
    if (!PATH_SEGMENT_RE.test(seg)) {
      throw new CliError(
        EXIT.USAGE,
        `identity '${raw}' has invalid path segment '${seg}': must match ^[a-zA-Z0-9_-]+$`,
      );
    }
  }

  // Source: either host/owner/repo (git) or host alone.
  const sourceSegments = sourcePart.split("/");
  if (sourceSegments.length === 1) {
    // host alone (server-hosted)
    const host = sourceSegments[0] as string;
    if (!HOST_RE.test(host)) {
      throw new CliError(EXIT.USAGE, `identity '${raw}' source '${host}' is not a valid DNS name`);
    }
    return {
      raw,
      source: host,
      isGit: false,
      host,
      ref,
      refKind,
      path,
      pathSegments,
    };
  }
  if (sourceSegments.length === 3) {
    const [host, owner, repo] = sourceSegments as [string, string, string];
    if (!HOST_RE.test(host)) {
      throw new CliError(EXIT.USAGE, `identity '${raw}' host '${host}' is not a valid DNS name`);
    }
    if (owner.length === 0 || repo.length === 0) {
      throw new CliError(EXIT.USAGE, `identity '${raw}' has empty owner or repo`);
    }
    return {
      raw,
      source: `${host}/${owner}/${repo}`,
      isGit: true,
      host,
      owner,
      repo,
      ref,
      refKind,
      path,
      pathSegments,
    };
  }
  throw new CliError(
    EXIT.USAGE,
    `identity '${raw}' source '${sourcePart}' has ${sourceSegments.length} segments; expected 1 (host alone) or 3 (host/owner/repo)`,
  );
};

/**
 * Format an identity from components. The inverse of parseIdentity.
 */
export const formatIdentity = (parts: {
  source: string;
  ref: string;
  path: string;
}): string => {
  return `${parts.source}@${parts.ref}/${parts.path}`;
};

/**
 * Returns true if the identity is "production-grade" — i.e., pinned to a
 * commit hash, not a mutable tag or "latest".
 */
export const isImmutableIdentity = (id: ParsedIdentity): boolean => id.refKind === "hash";
