import { describe, expect, it } from "vitest";
import {
  formatIdentity,
  isImmutableIdentity,
  parseIdentity,
} from "../../src/lib/identity.js";

const HASH40 = "a1b2c3d4e5f67890abcdef1234567890abcdef12";
const HASH64 = "a1b2c3d4e5f67890abcdef1234567890abcdef12abcdef1234567890abcdef12abc";

describe("parseIdentity — git source", () => {
  it("parses canonical github identity with SHA-1 ref", () => {
    const id = parseIdentity(`github.com/stripe/agent-skills@${HASH40}/charge-customer`);
    expect(id.isGit).toBe(true);
    expect(id.host).toBe("github.com");
    expect(id.owner).toBe("stripe");
    expect(id.repo).toBe("agent-skills");
    expect(id.ref).toBe(HASH40);
    expect(id.refKind).toBe("hash");
    expect(id.path).toBe("charge-customer");
    expect(id.pathSegments).toEqual(["charge-customer"]);
  });

  it("parses SHA-256 ref (≥40 hex)", () => {
    const id = parseIdentity(`github.com/example/skills@${HASH64}/x`);
    expect(id.refKind).toBe("hash");
    expect(id.ref).toBe(HASH64);
  });

  it("parses tag ref", () => {
    const id = parseIdentity("gitlab.com/some-org/skills@v1.2.0/send-email");
    expect(id.refKind).toBe("tag");
    expect(id.ref).toBe("v1.2.0");
    expect(id.host).toBe("gitlab.com");
  });

  it("parses semver-with-suffix tag", () => {
    const id = parseIdentity("github.com/x/y@1.0.0-beta.1/skill");
    expect(id.refKind).toBe("tag");
    expect(id.ref).toBe("1.0.0-beta.1");
  });

  it("parses self-hosted git host", () => {
    const id = parseIdentity(`git.example.com/team/internal-skills@${HASH40}/deploy`);
    expect(id.host).toBe("git.example.com");
    expect(id.owner).toBe("team");
    expect(id.repo).toBe("internal-skills");
  });

  it("parses multi-segment path", () => {
    const id = parseIdentity(`github.com/a/b@${HASH40}/group/sub/skill-name`);
    expect(id.path).toBe("group/sub/skill-name");
    expect(id.pathSegments).toEqual(["group", "sub", "skill-name"]);
  });
});

describe("parseIdentity — server-hosted source", () => {
  it("parses host-alone with latest ref", () => {
    const id = parseIdentity("img.automators.work@latest/placeholder");
    expect(id.isGit).toBe(false);
    expect(id.host).toBe("img.automators.work");
    expect(id.owner).toBeUndefined();
    expect(id.repo).toBeUndefined();
    expect(id.refKind).toBe("latest");
    expect(id.path).toBe("placeholder");
  });
});

describe("parseIdentity — error cases", () => {
  it("rejects empty string", () => {
    expect(() => parseIdentity("")).toThrow(/empty/);
  });

  it("rejects missing @", () => {
    expect(() => parseIdentity("github.com/x/y/path")).toThrow(/missing @/);
  });

  it("rejects empty source", () => {
    expect(() => parseIdentity("@v1.0/skill")).toThrow(/empty source/);
  });

  it("rejects empty ref", () => {
    expect(() => parseIdentity("github.com/x/y@/skill")).toThrow(/empty ref/);
  });

  it("rejects empty path", () => {
    expect(() => parseIdentity(`github.com/x/y@${HASH40}/`)).toThrow(/empty path/);
  });

  it("rejects ref with invalid characters", () => {
    expect(() => parseIdentity("github.com/x/y@with space/skill")).toThrow(/invalid ref/);
  });

  it("rejects path with invalid characters", () => {
    expect(() => parseIdentity(`github.com/x/y@${HASH40}/with.dot`)).toThrow(/invalid path segment/);
  });

  it("rejects 2-segment source (neither host nor host/owner/repo)", () => {
    expect(() => parseIdentity(`github.com/incomplete@${HASH40}/skill`)).toThrow(/segments/);
  });

  it("rejects 4-segment source", () => {
    expect(() => parseIdentity(`github.com/a/b/c@${HASH40}/skill`)).toThrow(/segments/);
  });

  it("rejects host that's not a valid DNS name", () => {
    expect(() => parseIdentity(`localhost@${HASH40}/skill`)).toThrow(/DNS name/);
  });

  it("classifies 39 hex chars as a tag (not hash) — hash requires ≥40", () => {
    // 39 a's matches the tag regex but not the hash regex; valid as tag per spec.
    const short = "a".repeat(39);
    const id = parseIdentity(`github.com/x/y@${short}/skill`);
    expect(id.refKind).toBe("tag");
    expect(id.ref).toBe(short);
  });
});

describe("formatIdentity", () => {
  it("round-trips parsed identities", () => {
    const original = `github.com/stripe/agent-skills@${HASH40}/charge-customer`;
    const id = parseIdentity(original);
    expect(formatIdentity({ source: id.source, ref: id.ref, path: id.path })).toBe(original);
  });
});

describe("isImmutableIdentity", () => {
  it("true for hash refs", () => {
    expect(isImmutableIdentity(parseIdentity(`github.com/x/y@${HASH40}/s`))).toBe(true);
  });

  it("false for tag refs", () => {
    expect(isImmutableIdentity(parseIdentity("github.com/x/y@v1.0.0/s"))).toBe(false);
  });

  it("false for latest", () => {
    expect(isImmutableIdentity(parseIdentity("host.com@latest/s"))).toBe(false);
  });
});
