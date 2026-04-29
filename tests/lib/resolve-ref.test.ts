// Tests for resolveRef — the GitHub ref → commit-SHA resolution used by sync.
//
// Annotated tag bug: discovered E2E when releasing v2.1.0 of agent-skills-pack.
// The CLI was hitting `/git/refs/tags/{ref}` first; for annotated tags that
// returns `object.sha` = the *tag object's* sha (not the commit). jsdelivr's
// `@<sha>` URL pattern doesn't accept the tag-object sha → 404 on
// skills-index.json fetch. Verified empirically:
//
//   git rev-parse v2.1.0          → a0c52135...  (tag object)
//   git rev-parse v2.1.0^{commit} → a0906001...  (commit)
//   /git/refs/tags/v2.1.0 → object.sha = a0c52135 (tag object)
//   /commits/v2.1.0       → sha = a0906001       (commit)
//
// Fix: try /commits/{ref} first, fall back to /git/refs/tags + dereference.

import { describe, expect, it } from "vitest";
import { resolveRef } from "../../src/commands/sync.js";

const COMMIT_SHA = "a0906001e289ced1748909cca0a99c06c24a03c1";
const TAG_OBJECT_SHA = "a0c52135bead2bed82b6f2a09b58ce816b47dfb1";

describe("resolveRef — commits endpoint (preferred path)", () => {
  it("resolves a tag to its commit SHA via /commits/{ref}", async () => {
    let calls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/commits/v2.1.0")) {
        return new Response(JSON.stringify({ sha: COMMIT_SHA }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const sha = await resolveRef("github.com/foo/bar", "v2.1.0", fetchImpl as typeof fetch);
    expect(sha).toBe(COMMIT_SHA);
    // Must hit /commits/ FIRST and stop there.
    expect(calls[0]).toContain("/commits/v2.1.0");
  });

  it("resolves a 40-hex SHA without any HTTP call", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response("not found", { status: 404 });
    };
    const sha = await resolveRef("github.com/foo/bar", COMMIT_SHA, fetchImpl as typeof fetch);
    expect(sha).toBe(COMMIT_SHA);
    expect(calls).toBe(0);
  });
});

describe("resolveRef — annotated tag dereference (fallback path)", () => {
  it("dereferences an annotated tag through /git/refs/tags then /git/tags", async () => {
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      // /commits/{ref} fails for this hypothetical case (e.g. rate-limited
      // or odd auth situation) — force fallback to refs/tags.
      if (u.endsWith("/commits/v2.1.0")) {
        return new Response("forbidden", { status: 403 });
      }
      // /git/refs/tags returns an ANNOTATED tag → object.type === "tag",
      // object.sha === tag-object SHA (NOT the commit).
      if (u.endsWith("/git/refs/tags/v2.1.0")) {
        return new Response(
          JSON.stringify({
            ref: "refs/tags/v2.1.0",
            object: {
              sha: TAG_OBJECT_SHA,
              type: "tag",
              url: `https://api.github.com/repos/foo/bar/git/tags/${TAG_OBJECT_SHA}`,
            },
          }),
          { status: 200 },
        );
      }
      // /git/tags/{tag-sha} → here `object.sha` IS the commit.
      if (u.endsWith(`/git/tags/${TAG_OBJECT_SHA}`)) {
        return new Response(
          JSON.stringify({
            tag: "v2.1.0",
            object: { sha: COMMIT_SHA, type: "commit" },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const sha = await resolveRef("github.com/foo/bar", "v2.1.0", fetchImpl as typeof fetch);
    // Must NOT return the tag-object SHA.
    expect(sha).not.toBe(TAG_OBJECT_SHA);
    expect(sha).toBe(COMMIT_SHA);
  });

  it("uses /git/refs/tags directly when object.type is 'commit' (lightweight tag)", async () => {
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/commits/light-tag")) {
        return new Response("forbidden", { status: 403 });
      }
      if (u.endsWith("/git/refs/tags/light-tag")) {
        return new Response(
          JSON.stringify({
            ref: "refs/tags/light-tag",
            // Lightweight tag points directly at a commit.
            object: { sha: COMMIT_SHA, type: "commit" },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const sha = await resolveRef("github.com/foo/bar", "light-tag", fetchImpl as typeof fetch);
    expect(sha).toBe(COMMIT_SHA);
  });
});

describe("resolveRef — failures", () => {
  it("throws CliError when neither /commits/{ref} nor /git/refs/tags resolve", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    await expect(
      resolveRef("github.com/foo/bar", "no-such-ref", fetchImpl as typeof fetch),
    ).rejects.toThrow(/cannot resolve ref/);
  });

  it("rejects non-GitHub repos with a clear message", async () => {
    const fetchImpl = async () => new Response("", { status: 200 });
    await expect(
      resolveRef("gitlab.com/foo/bar", "main", fetchImpl as typeof fetch),
    ).rejects.toThrow(/non-GitHub host/);
  });
});
