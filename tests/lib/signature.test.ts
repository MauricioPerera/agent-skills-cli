// Tests for tag-signature verification (v0.10.0).
// Mocks GitHub API responses to exercise every branch of verifyGitHubTag
// without hitting the network.

import { describe, expect, it } from "vitest";
import {
  detectSignatureMethod,
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

// ────────────────────────────────────────────────────────────────────
// detectSignatureMethod (v0.14.0+)
// ────────────────────────────────────────────────────────────────────

describe("detectSignatureMethod — structural PEM-header detection", () => {
  it("returns 'gpg' for traditional OpenPGP-armored signatures", () => {
    const gpgSig = `-----BEGIN PGP SIGNATURE-----

iQIzBAABCgAdFiEE12345abc...
-----END PGP SIGNATURE-----`;
    expect(detectSignatureMethod(gpgSig)).toBe("gpg");
  });

  it("returns 'sigstore' for gitsign / Sigstore CMS signatures", () => {
    const sigstoreSig = `-----BEGIN SIGNED MESSAGE-----
MIIBuAYJKoZIhvcNAQcCoIIBqTCCAaUCAQExDzANBglghkgBZQMEAgEFADALBgkq...
-----END SIGNED MESSAGE-----`;
    expect(detectSignatureMethod(sigstoreSig)).toBe("sigstore");
  });

  it("returns 'ssh' for SSH-format git signatures (v0.15.0+)", () => {
    // Real shape from sigstore/cosign@v3.0.6's tag verification block.
    const sshSig = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAAGgAAAATZWNkc2Etc2hhMi1uaXN0cDI1NgAAAAhuaXN0cDI1NgAAAE
EEa8T1Y/vsKA1qPB5FHCcTu38N+BySGXZyN9EY6TRgEYttomaX+IeziiCioTyxwqrlCVFT
-----END SSH SIGNATURE-----`;
    expect(detectSignatureMethod(sshSig)).toBe("ssh");
  });

  it("distinguishes SSH from PGP/sigstore even when payloads are similar", () => {
    // Belt-and-suspenders: the headers differ by a single keyword.
    expect(detectSignatureMethod("-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----")).toBe("gpg");
    expect(detectSignatureMethod("-----BEGIN SSH SIGNATURE-----\nx\n-----END SSH SIGNATURE-----")).toBe("ssh");
    expect(detectSignatureMethod("-----BEGIN SIGNED MESSAGE-----\nx\n-----END SIGNED MESSAGE-----")).toBe("sigstore");
  });

  it("returns undefined for unrecognised payloads", () => {
    expect(detectSignatureMethod("just some random text")).toBeUndefined();
    expect(detectSignatureMethod("-----BEGIN CERTIFICATE-----\n...")).toBeUndefined();
  });

  it("returns undefined for null / undefined / empty", () => {
    expect(detectSignatureMethod(null)).toBeUndefined();
    expect(detectSignatureMethod(undefined)).toBeUndefined();
    expect(detectSignatureMethod("")).toBeUndefined();
  });

  it("detects the marker even with surrounding whitespace or trailing content", () => {
    const padded = `\n\n  some preamble\n-----BEGIN PGP SIGNATURE-----\nactual sig\n-----END PGP SIGNATURE-----\nfooter\n`;
    expect(detectSignatureMethod(padded)).toBe("gpg");
  });

  it("does NOT match a header substring without the full PEM line (avoids false positives)", () => {
    // Just having the words "PGP SIGNATURE" elsewhere shouldn't trigger.
    expect(detectSignatureMethod("PGP SIGNATURE algorithm: RSA")).toBeUndefined();
    expect(detectSignatureMethod("BEGIN PGP SIGNATURE")).toBeUndefined();
  });
});

describe("verifyGitHubTag — signature method propagated to result", () => {
  // Reuse the mockFetch + okJson helpers from the top of the file.
  const mockFetch = (handler: (url: string) => Response): typeof fetch =>
    (async (url: string | URL | Request) => handler(url.toString())) as unknown as typeof fetch;
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("status='valid' + Sigstore payload → result.method = 'sigstore'", async () => {
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v1.0.0",
          tagger: { name: "Alice", email: "alice@example.com" },
          verification: {
            verified: true,
            reason: "valid",
            signature: "-----BEGIN SIGNED MESSAGE-----\nMIIBuAYJ...\n-----END SIGNED MESSAGE-----",
            payload: "object ...",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("valid");
    expect(result.method).toBe("sigstore");
  });

  it("status='valid' + GPG payload → result.method = 'gpg'", async () => {
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v1.0.0",
          tagger: { name: "Bob", email: "bob@example.com" },
          verification: {
            verified: true,
            reason: "valid",
            signature: "-----BEGIN PGP SIGNATURE-----\niQIzBAABCgAd...\n-----END PGP SIGNATURE-----",
            payload: "object ...",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("valid");
    expect(result.method).toBe("gpg");
  });

  it("status='unsigned' → result.method is undefined (no payload to inspect)", async () => {
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v1.0.0",
          tagger: { name: "Carol", email: "carol@example.com" },
          verification: {
            verified: false,
            reason: "unsigned",
            signature: null,
            payload: null,
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("unsigned");
    expect(result.method).toBeUndefined();
  });

  it("status='invalid' + GPG payload → method still detected ('gpg' with status='invalid')", async () => {
    // An invalid signature still has a payload; we surface the method for
    // operator visibility — they can see WHICH crypto system failed.
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v1.0.0",
          tagger: { email: "dave@example.com" },
          verification: {
            verified: false,
            reason: "unknown_key",
            signature: "-----BEGIN PGP SIGNATURE-----\n...\n-----END PGP SIGNATURE-----",
            payload: "object ...",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.status).toBe("invalid");
    expect(result.method).toBe("gpg");
    expect(result.reason).toBe("unknown_key");
  });
});

// ────────────────────────────────────────────────────────────────────
// verifyGitHubTag — Sigstore identity extraction (v0.16.0+)
// ────────────────────────────────────────────────────────────────────
describe("verifyGitHubTag — Sigstore identity propagated to result", () => {
  const mockFetch = (handler: (url: string) => Response): typeof fetch =>
    (async (url: string | URL | Request) => handler(url.toString())) as unknown as typeof fetch;
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  // Use the real sigstore/gitsign@v0.14.0 CMS payload as the fixture so the
  // mocked GitHub response reflects an actual Fulcio-issued cert. This proves
  // the wire (verifyGitHubTag → CMS walker → identity field) end-to-end.
  const loadGitsignVerification = async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(
      readFileSync(resolve(here, "../fixtures/gitsign-v0.14.0-verification.json"), "utf8"),
    ) as { signature: string; payload: string; reason: string; verified: boolean };
  };

  it("populates result.identity for sigstore-method tags (real gitsign payload)", async () => {
    const fixture = await loadGitsignVerification();
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v0.14.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v0.14.0",
          tagger: { name: "Billy Lynch", email: "billy@chainguard.dev" },
          verification: {
            // Use status as actually returned by GitHub for this tag —
            // bad_cert is the canonical "Sigstore-on-host trap" case
            // (signature is real, Fulcio cert has expired since signing).
            verified: false,
            reason: "bad_cert",
            signature: fixture.signature,
            payload: fixture.payload,
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/sigstore/gitsign", "v0.14.0", fetchFn);
    expect(result.status).toBe("invalid");
    expect(result.method).toBe("sigstore");
    expect(result.identity).toBeDefined();
    expect(result.identity!.subject).toBe("billy@chainguard.dev");
    expect(result.identity!.subject_type).toBe("email");
    expect(result.identity!.issuer).toBe("https://accounts.google.com");
  });

  it("does NOT populate identity for gpg-method tags", async () => {
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v1.0.0",
          tagger: { email: "alice@example.com" },
          verification: {
            verified: true,
            reason: "valid",
            signature: "-----BEGIN PGP SIGNATURE-----\niQ...\n-----END PGP SIGNATURE-----",
            payload: "object ...",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.method).toBe("gpg");
    expect(result.identity).toBeUndefined();
  });

  it("does NOT populate identity for ssh-method tags", async () => {
    const fetchFn = mockFetch((u) => {
      if (u.includes("/git/refs/tags/")) {
        return okJson({ ref: "refs/tags/v1.0.0", object: { sha: "tag-sha", type: "tag" } });
      }
      if (u.includes("/git/tags/tag-sha")) {
        return okJson({
          tag: "v1.0.0",
          tagger: { email: "bob@example.com" },
          verification: {
            verified: true,
            reason: "valid",
            signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH...\n-----END SSH SIGNATURE-----",
            payload: "object ...",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await verifyGitHubTag("github.com/me/pack", "v1.0.0", fetchFn);
    expect(result.method).toBe("ssh");
    expect(result.identity).toBeUndefined();
  });
});
