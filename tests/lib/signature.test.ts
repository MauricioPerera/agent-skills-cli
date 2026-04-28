// Tests for tag-signature verification (v0.10.0).
// Mocks GitHub API responses to exercise every branch of verifyGitHubTag
// without hitting the network.

import { describe, expect, it } from "vitest";
import {
  enforceVerification,
  verifyGitHubTag,
  type SignatureVerification,
} from "../../src/lib/signature.js";

// Build a fake `fetch` that responds based on URL pattern.
const mockFetch = (handlers: Record<string, () => Response>): typeof fetch => {
  return async (url) => {
    const u = url.toString();
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (u.includes(pattern)) return handler();
    }
    return new Response("not found", { status: 404 });
  };
};

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("verifyGitHubTag — non-applicable inputs", () => {
  it("returns 'unverified' for non-GitHub hosts", async () => {
    const fetchFn = mockFetch({});
    const result = await verifyGitHubTag("gitlab.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/not supported/i);
  });

  it("returns 'unverified' when the ref is a raw commit hash", async () => {
    const fetchFn = mockFetch({});
    const result = await verifyGitHubTag(
      "github.com/me/pack",
      "abcdef1234567890abcdef1234567890abcdef12",
      fetchFn,
    );
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/raw commit hash/i);
  });
});

describe("verifyGitHubTag — annotated tags", () => {
  it("returns 'valid' when GitHub reports verified=true", async () => {
    const fetchFn = mockFetch({
      "/git/refs/tags/v1.0.0": () =>
        okJson({
          ref: "refs/tags/v1.0.0",
          object: { sha: "tag-sha-123", type: "tag" },
        }),
      "/git/tags/tag-sha-123": () =>
        okJson({
          tag: "v1.0.0",
          tagger: { name: "Alice", email: "alice@example.com" },
          verification: {
            verified: true,
            reason: "valid",
            signature: "-----BEGIN PGP SIGNATURE-----...",
            payload: "object ...",
          },
        }),
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("valid");
    expect(result.reason).toBe("valid");
    expect(result.signed_by).toBe("Alice <alice@example.com>");
  });

  it("returns 'unsigned' when GitHub reports verified=false reason='unsigned'", async () => {
    const fetchFn = mockFetch({
      "/git/refs/tags/v1.0.0": () =>
        okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } }),
      "/git/tags/tag-sha": () =>
        okJson({
          tag: "v1.0.0",
          tagger: { name: "Bob", email: "bob@example.com" },
          verification: {
            verified: false,
            reason: "unsigned",
            signature: null,
            payload: null,
          },
        }),
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("unsigned");
    expect(result.signed_by).toBe("Bob <bob@example.com>");
  });

  it("returns 'invalid' when verified=false but a signature is present (e.g., unknown_key)", async () => {
    const fetchFn = mockFetch({
      "/git/refs/tags/v1.0.0": () =>
        okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } }),
      "/git/tags/tag-sha": () =>
        okJson({
          tag: "v1.0.0",
          tagger: { email: "carol@example.com" },
          verification: {
            verified: false,
            reason: "unknown_key",
            signature: "-----BEGIN PGP SIGNATURE-----...",
            payload: "object ...",
          },
        }),
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("unknown_key");
    expect(result.signed_by).toBe("<carol@example.com>");
  });
});

describe("verifyGitHubTag — lightweight tags + edge cases", () => {
  it("returns 'unsigned' for lightweight tags (object.type='commit')", async () => {
    const fetchFn = mockFetch({
      "/git/refs/tags/light": () =>
        okJson({
          ref: "refs/tags/light",
          object: { sha: "commit-sha", type: "commit" },
        }),
    });

    const result = await verifyGitHubTag("github.com/me/pack", "light", fetchFn);
    expect(result.status).toBe("unsigned");
    expect(result.reason).toMatch(/lightweight/i);
  });

  it("returns 'unverified' when GitHub returns 404 for the ref", async () => {
    const fetchFn = mockFetch({});
    const result = await verifyGitHubTag("github.com/me/pack", "no-such-tag", fetchFn);
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/not found/i);
  });

  it("returns 'unverified' on rate-limit / non-404 GitHub errors", async () => {
    const fetchFn = mockFetch({
      "/git/refs/tags/": () =>
        new Response("rate limited", { status: 403, statusText: "Forbidden" }),
    });
    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/403/);
  });

  it("returns 'unverified' if the verification block is missing entirely", async () => {
    const fetchFn = mockFetch({
      "/git/refs/tags/v1.0.0": () =>
        okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } }),
      "/git/tags/tag-sha": () =>
        okJson({ tag: "v1.0.0", tagger: { name: "Alice" } }),
    });
    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/no verification block/i);
  });

  it("URL-encodes tag names containing special characters", async () => {
    let calledUrl = "";
    const fetchFn = (async (url: string | URL) => {
      calledUrl = url.toString();
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await verifyGitHubTag("github.com/me/pack", "release/v1.0.0", fetchFn);
    expect(calledUrl).toContain("release%2Fv1.0.0");
  });
});

describe("enforceVerification", () => {
  const v = (status: SignatureVerification["status"], reason = "test"): SignatureVerification => ({
    status,
    reason,
  });

  it("does NOT throw on status='valid'", () => {
    expect(() => enforceVerification(v("valid"), "github.com/me/pack", "v1.0.0")).not.toThrow();
  });

  it("throws CliError on every other status", () => {
    for (const status of ["unsigned", "invalid", "unverified"] as const) {
      expect(() =>
        enforceVerification(v(status), "github.com/me/pack", "v1.0.0"),
      ).toThrow(/signature verification failed/i);
    }
  });

  it("includes the tagger in the error message when available", () => {
    const result: SignatureVerification = {
      status: "invalid",
      reason: "unknown_key",
      signed_by: "Alice <alice@example.com>",
    };
    expect(() =>
      enforceVerification(result, "github.com/me/pack", "v1.0.0"),
    ).toThrow(/Alice <alice@example\.com>/);
  });
});
