import { describe, expect, it } from "vitest";
import { parseIdentity } from "../../src/lib/identity.js";
import { deriveSkillsIndexUrls, deriveUrls, renderTemplate } from "../../src/lib/url.js";

const HASH = "a1b2c3d4e5f67890abcdef1234567890abcdef12";

describe("deriveUrls — github.com", () => {
  it("returns jsDelivr first, then raw.githubusercontent", () => {
    const id = parseIdentity(`github.com/stripe/agent-skills@${HASH}/charge-customer`);
    const urls = deriveUrls(id);
    expect(urls.length).toBe(2);
    expect(urls[0]).toBe(
      `https://cdn.jsdelivr.net/gh/stripe/agent-skills@${HASH}/charge-customer/SKILL.md`,
    );
    expect(urls[1]).toBe(
      `https://raw.githubusercontent.com/stripe/agent-skills/${HASH}/charge-customer/SKILL.md`,
    );
  });

  it("works with tag refs", () => {
    const id = parseIdentity("github.com/x/y@v1.0.0/skill");
    expect(deriveUrls(id)[0]).toContain("@v1.0.0/");
  });
});

describe("deriveUrls — gitlab.com", () => {
  it("uses gitlab raw URL", () => {
    const id = parseIdentity("gitlab.com/some-org/skills@v1.2.0/send-email");
    const urls = deriveUrls(id);
    expect(urls).toEqual([
      "https://gitlab.com/some-org/skills/-/raw/v1.2.0/send-email/SKILL.md",
    ]);
  });
});

describe("deriveUrls — bitbucket.org", () => {
  it("uses bitbucket raw URL", () => {
    const id = parseIdentity(`bitbucket.org/team/proj@${HASH}/x`);
    const urls = deriveUrls(id);
    expect(urls).toEqual([
      `https://bitbucket.org/team/proj/raw/${HASH}/x/SKILL.md`,
    ]);
  });
});

describe("deriveUrls — server-hosted (host alone)", () => {
  it("uses /skills/<path>/SKILL.md", () => {
    const id = parseIdentity("img.automators.work@latest/placeholder");
    expect(deriveUrls(id)).toEqual([
      "https://img.automators.work/skills/placeholder/SKILL.md",
    ]);
  });
});

describe("deriveUrls — provider-supplied url_template", () => {
  it("takes precedence over built-in", () => {
    const id = parseIdentity(`github.com/x/y@${HASH}/path`);
    const custom = "https://my-cdn.example.com/{owner}/{repo}@{ref}/{path}/SKILL.md";
    const urls = deriveUrls(id, custom);
    expect(urls).toEqual([
      `https://my-cdn.example.com/x/y@${HASH}/path/SKILL.md`,
    ]);
  });

  it("works for self-hosted git via custom template", () => {
    const id = parseIdentity(`git.internal.example.com/team/skills@${HASH}/deploy`);
    const custom = "https://internal-cdn.example.com/{owner}/{repo}/{ref}/{path}/SKILL.md";
    const urls = deriveUrls(id, custom);
    expect(urls).toEqual([
      `https://internal-cdn.example.com/team/skills/${HASH}/deploy/SKILL.md`,
    ]);
  });
});

describe("deriveUrls — error cases", () => {
  it("rejects unknown git host without url_template", () => {
    const id = parseIdentity(`git.unknown.example.com/x/y@${HASH}/skill`);
    expect(() => deriveUrls(id)).toThrow(/no built-in URL template/);
  });
});

describe("deriveSkillsIndexUrls", () => {
  it("github.com returns jsDelivr + raw.githubusercontent", () => {
    const id = parseIdentity(`github.com/stripe/agent-skills@${HASH}/x`);
    const urls = deriveSkillsIndexUrls(id);
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/stripe/agent-skills@${HASH}/skills-index.json`.replace("/stripe", "/gh/stripe"),
    );
  });

  it("server-hosted uses /skills-index.json at root", () => {
    const id = parseIdentity("img.automators.work@latest/placeholder");
    expect(deriveSkillsIndexUrls(id)).toEqual([
      "https://img.automators.work/skills-index.json",
    ]);
  });
});

describe("renderTemplate", () => {
  it("substitutes all known placeholders", () => {
    const result = renderTemplate(
      "https://{host}/{owner}/{repo}/{ref}/{path}/SKILL.md",
      { host: "h", owner: "o", repo: "r", ref: "v1", path: "p" },
    );
    expect(result).toBe("https://h/o/r/v1/p/SKILL.md");
  });

  it("leaves unknown placeholders intact (forward-compat for new template vars)", () => {
    const result = renderTemplate("{unknown}-{ref}", { ref: "v1", path: "", host: "" });
    expect(result).toBe("{unknown}-v1");
  });
});
