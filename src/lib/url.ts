// URL derivation per agent-skills SPEC.md §1.1.
//
// Two methods:
//   A. Provider-declared via skills-index.json's url_template (preferred).
//   B. Built-in templates for known git hosts (fallback).

import type { ParsedIdentity } from "./identity.js";
import { CliError, EXIT } from "./errors.js";

export interface UrlTemplateContext {
  owner?: string;
  repo?: string;
  ref: string;
  path: string;
  host: string;
}

/**
 * Built-in URL templates for known hosts. Order matters when a host has
 * multiple templates: banks SHOULD attempt them in order.
 */
const BUILTIN_TEMPLATES: ReadonlyArray<{
  host: string;
  isGit: boolean;
  template: string;
}> = [
  // GitHub: jsDelivr first (CDN-cached, fast), then raw.githubusercontent.com.
  {
    host: "github.com",
    isGit: true,
    template: "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}/SKILL.md",
  },
  {
    host: "github.com",
    isGit: true,
    template: "https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}/SKILL.md",
  },
  {
    host: "gitlab.com",
    isGit: true,
    template: "https://gitlab.com/{owner}/{repo}/-/raw/{ref}/{path}/SKILL.md",
  },
  {
    host: "bitbucket.org",
    isGit: true,
    template: "https://bitbucket.org/{owner}/{repo}/raw/{ref}/{path}/SKILL.md",
  },
];

const renderTemplate = (template: string, ctx: UrlTemplateContext): string => {
  return template
    .replace(/\{owner\}/g, ctx.owner ?? "")
    .replace(/\{repo\}/g, ctx.repo ?? "")
    .replace(/\{ref\}/g, ctx.ref)
    .replace(/\{path\}/g, ctx.path)
    .replace(/\{host\}/g, ctx.host);
};

/**
 * Derive the fetchable URL(s) for a skill identity.
 *
 * If `urlTemplate` is provided (e.g., from skills-index.json), it takes
 * precedence and returns a single-element array.
 *
 * Otherwise, returns all built-in candidate URLs for the host, in priority
 * order. The bank should attempt each in sequence until one succeeds.
 *
 * Server-hosted (host alone) identities use a single template:
 *   https://{host}/skills/{path}/SKILL.md
 */
export const deriveUrls = (
  id: ParsedIdentity,
  urlTemplate?: string,
): string[] => {
  const ctx: UrlTemplateContext = {
    owner: id.owner,
    repo: id.repo,
    ref: id.ref,
    path: id.path,
    host: id.host,
  };

  if (urlTemplate !== undefined) {
    return [renderTemplate(urlTemplate, ctx)];
  }

  // Server-hosted (host alone)
  if (!id.isGit) {
    return [renderTemplate("https://{host}/skills/{path}/SKILL.md", ctx)];
  }

  // Git host: find all built-in templates for this host
  const matches = BUILTIN_TEMPLATES.filter(
    (t) => t.isGit && t.host === id.host,
  );

  if (matches.length === 0) {
    throw new CliError(
      EXIT.USAGE,
      `no built-in URL template for host '${id.host}'; provider must supply url_template via skills-index.json`,
    );
  }

  return matches.map((t) => renderTemplate(t.template, ctx));
};

/**
 * Derive the URL for a provider's skills-index.json. Same logic as deriveUrls
 * but for the index file at the source root.
 *
 * NOTE: jsDelivr requires a file path; the convention is to fetch
 * skills-index.json from the repo root.
 */
export const deriveSkillsIndexUrls = (id: ParsedIdentity): string[] => {
  const ctx: UrlTemplateContext = {
    owner: id.owner,
    repo: id.repo,
    ref: id.ref,
    path: "skills-index.json", // file at source root, not in a subpath
    host: id.host,
  };

  if (!id.isGit) {
    return [`https://${id.host}/skills-index.json`];
  }

  const githubTemplates = [
    "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/skills-index.json",
    "https://raw.githubusercontent.com/{owner}/{repo}/{ref}/skills-index.json",
  ];
  const gitlabTemplate = "https://gitlab.com/{owner}/{repo}/-/raw/{ref}/skills-index.json";
  const bitbucketTemplate = "https://bitbucket.org/{owner}/{repo}/raw/{ref}/skills-index.json";

  if (id.host === "github.com") return githubTemplates.map((t) => renderTemplate(t, ctx));
  if (id.host === "gitlab.com") return [renderTemplate(gitlabTemplate, ctx)];
  if (id.host === "bitbucket.org") return [renderTemplate(bitbucketTemplate, ctx)];

  throw new CliError(
    EXIT.USAGE,
    `no built-in skills-index.json template for host '${id.host}'`,
  );
};

export { renderTemplate };
