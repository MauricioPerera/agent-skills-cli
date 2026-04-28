import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  parseRekorEntry,
  fetchRekorEntry,
  findRekorEntryByHash,
  REKOR_PUBLIC_HOST,
} from "../../src/lib/rekor.js";
import { CliError } from "../../src/lib/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../fixtures/rekor-entry-sample.json");

const loadFixture = (): unknown => JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("parseRekorEntry — real Rekor response", () => {
  // Fixture is the actual /api/v1/log/entries/<uuid> response for a real
  // sigstore-signed entry (one of Billy Lynch's gitsign signatures).
  // Validates that the parser handles the live API shape.

  it("unwraps the single-entry-keyed-by-UUID outer object", () => {
    const entry = parseRekorEntry(loadFixture());
    expect(entry.uuid).toMatch(/^[a-f0-9]+$/);
    expect(entry.uuid.length).toBeGreaterThanOrEqual(64);
  });

  it("extracts immutable entry metadata", () => {
    const entry = parseRekorEntry(loadFixture());
    expect(entry.logIndex).toBe(1175471798);
    expect(entry.integratedTime).toBe(1774386393);
    expect(entry.logID).toMatch(/^[a-f0-9]{64}$/);
  });

  it("decodes the base64 body into a hashedrekord", () => {
    const entry = parseRekorEntry(loadFixture());
    expect(entry.body.kind).toBe("hashedrekord");
    expect(entry.body.apiVersion).toBe("0.0.1");
    expect(entry.body.spec.data.hash.algorithm).toBe("sha256");
    expect(entry.body.spec.data.hash.value).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.body.spec.signature.content.length).toBeGreaterThan(0);
    expect(entry.body.spec.signature.publicKey.content.length).toBeGreaterThan(0);
  });

  it("preserves the inclusion proof verbatim (snapshot semantics)", () => {
    const entry = parseRekorEntry(loadFixture());
    const p = entry.inclusionProof;
    // entry.logIndex is the GLOBAL index across all Rekor shards;
    // inclusionProof.logIndex is the LOCAL index within this entry's
    // shard (entry.logID). They are NOT equal in general — that surprised
    // me during v0.17 development and would burn a verifier in v0.18+.
    expect(p.logIndex).toBeGreaterThanOrEqual(0);
    expect(p.logIndex).toBeLessThanOrEqual(entry.logIndex);
    expect(p.treeSize).toBeGreaterThan(p.logIndex);
    expect(p.rootHash).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
    expect(p.hashes.length).toBeGreaterThan(0);
    for (const h of p.hashes) {
      expect(h).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }
    // Real Rekor checkpoint is 5 lines: origin / size / root-b64 / blank / sig
    expect(p.checkpoint).toContain("rekor.sigstore.dev");
    const lines = p.checkpoint.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines[0]).toMatch(/^rekor\.sigstore\.dev - \d+$/);
    expect(lines[1]).toMatch(/^\d+$/); // tree size
    expect(lines[2]).toMatch(/^[A-Za-z0-9+/]+=*$/); // root-base64
  });

  it("checkpoint and inclusionProof claim the same root + size", () => {
    // Sanity: parser preserves both, and the redundant fields agree
    // (a future verifier will cross-check this).
    const entry = parseRekorEntry(loadFixture());
    const p = entry.inclusionProof;
    const lines = p.checkpoint.split("\n");
    const checkpointSize = parseInt(lines[1]!, 10);
    const checkpointRoot = lines[2]!;
    // Note: rootHash field is hex; checkpoint root is base64 of the same bytes.
    // We don't decode here (that's verifier work) but treeSize must match.
    expect(checkpointSize).toBe(p.treeSize);
    expect(checkpointRoot.length).toBeGreaterThan(0);
  });
});

describe("parseRekorEntry — defensive paths", () => {
  it("rejects non-object input", () => {
    expect(() => parseRekorEntry(null)).toThrow(CliError);
    expect(() => parseRekorEntry(undefined)).toThrow(CliError);
    expect(() => parseRekorEntry("hello")).toThrow(CliError);
    expect(() => parseRekorEntry(42)).toThrow(CliError);
  });

  it("rejects empty or multi-entry response", () => {
    expect(() => parseRekorEntry({})).toThrow(/single-entry/);
    expect(() => parseRekorEntry({ a: {}, b: {} })).toThrow(/single-entry/);
  });

  it("rejects missing immutable metadata", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    const uuid = Object.keys(fixture)[0]!;
    const entry = fixture[uuid] as Record<string, unknown>;
    const broken = { [uuid]: { ...entry, logIndex: undefined } };
    expect(() => parseRekorEntry(broken)).toThrow(/logIndex/);
  });

  it("rejects malformed body (bad base64 / not hashedrekord)", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    const uuid = Object.keys(fixture)[0]!;
    const entry = fixture[uuid] as Record<string, unknown>;
    const broken1 = { [uuid]: { ...entry, body: "!!!not-base64!!!" } };
    expect(() => parseRekorEntry(broken1)).toThrow(/base64/);
    // body decodes to JSON but kind is wrong
    const wrongKind = Buffer.from(
      JSON.stringify({ apiVersion: "0.0.1", kind: "intoto", spec: {} }),
      "utf8",
    ).toString("base64");
    const broken2 = { [uuid]: { ...entry, body: wrongKind } };
    expect(() => parseRekorEntry(broken2)).toThrow(/hashedrekord/);
  });

  it("rejects missing inclusion proof", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    const uuid = Object.keys(fixture)[0]!;
    const entry = fixture[uuid] as Record<string, unknown>;
    const broken = { [uuid]: { ...entry, verification: {} } };
    expect(() => parseRekorEntry(broken)).toThrow(/inclusionProof/);
  });
});

describe("fetchRekorEntry — input validation + transport errors", () => {
  it("rejects malformed UUID before any network call", async () => {
    let called = false;
    const fakeFetch: typeof fetch = async () => {
      called = true;
      return new Response("", { status: 200 });
    };
    await expect(fetchRekorEntry("not-a-uuid!", fakeFetch)).rejects.toThrow(
      /invalid entry UUID/,
    );
    expect(called).toBe(false);
  });

  it("returns parsed entry for a 200 response", async () => {
    const fixture = loadFixture();
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const entry = await fetchRekorEntry(
      "108e9186e8c5677a56a749f72dbd87f3b9af2d24e0ecbc1c1e550b6faa8965324d4ac76300ca7efe",
      fakeFetch,
    );
    expect(entry.logIndex).toBe(1175471798);
  });

  it("surfaces 404 distinctly from 5xx", async () => {
    const fakeFetch404: typeof fetch = async () => new Response("", { status: 404 });
    const fakeFetch500: typeof fetch = async () =>
      new Response("internal error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    const uuid = "1".repeat(64);
    await expect(fetchRekorEntry(uuid, fakeFetch404)).rejects.toThrow(/not found/);
    await expect(fetchRekorEntry(uuid, fakeFetch500)).rejects.toThrow(/500/);
  });

  it("targets the pinned public Rekor host by default", async () => {
    let observedUrl = "";
    const spyingFetch: typeof fetch = async (input) => {
      observedUrl = String(input);
      return new Response(JSON.stringify(loadFixture()), { status: 200 });
    };
    await fetchRekorEntry("1".repeat(64), spyingFetch);
    expect(observedUrl.startsWith(`${REKOR_PUBLIC_HOST}/api/v1/log/entries/`)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// findRekorEntryByHash — Rekor index/retrieve wrapper (v0.17.1+)
// ────────────────────────────────────────────────────────────────────

describe("findRekorEntryByHash — input validation + transport", () => {
  const validHash = "393d4b96fe4e0eae0fc313f5f8947c2a9782f189604d9f47ba7a66c709f2326e";

  it("rejects non-hex / wrong-length / uppercase hash before network call", async () => {
    let called = false;
    const fakeFetch: typeof fetch = async () => {
      called = true;
      return new Response("[]", { status: 200 });
    };
    await expect(findRekorEntryByHash("not-hex", fakeFetch)).rejects.toThrow(
      /64-char lower-case hex/,
    );
    await expect(findRekorEntryByHash("a".repeat(63), fakeFetch)).rejects.toThrow(
      /64-char lower-case hex/,
    );
    await expect(findRekorEntryByHash(validHash.toUpperCase(), fakeFetch)).rejects.toThrow(
      /lower-case/,
    );
    expect(called).toBe(false);
  });

  it("POSTs to /api/v1/index/retrieve with a sha256: prefix on the hash", async () => {
    let observedUrl = "";
    let observedBody: unknown = null;
    let observedMethod = "";
    const spyingFetch: typeof fetch = async (input, init) => {
      observedUrl = String(input);
      observedMethod = init?.method ?? "";
      observedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response("[]", { status: 200 });
    };
    await findRekorEntryByHash(validHash, spyingFetch);
    expect(observedUrl).toBe(`${REKOR_PUBLIC_HOST}/api/v1/index/retrieve`);
    expect(observedMethod).toBe("POST");
    expect(observedBody).toEqual({ hash: `sha256:${validHash}` });
  });

  it("returns the array of UUIDs verbatim on a 200 response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify(["abc123", "def456"]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const result = await findRekorEntryByHash(validHash, fakeFetch);
    expect(result).toEqual(["abc123", "def456"]);
  });

  it("returns empty array (no error) when Rekor finds no matching entries", async () => {
    // Real Rekor behavior: empty array means the hash isn't on a current
    // shard. v0.18 verifiers should treat this distinctly from "found but
    // proof failed" — see rekor.ts jsdoc on findRekorEntryByHash.
    const fakeFetch: typeof fetch = async () =>
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    const result = await findRekorEntryByHash(validHash, fakeFetch);
    expect(result).toEqual([]);
  });

  it("surfaces non-200 responses as CliError", async () => {
    const fakeFetch500: typeof fetch = async () =>
      new Response("oops", { status: 500, statusText: "Internal Server Error" });
    await expect(findRekorEntryByHash(validHash, fakeFetch500)).rejects.toThrow(/500/);
  });

  it("rejects non-array response shape", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('{"unexpected": "object"}', { status: 200 });
    await expect(findRekorEntryByHash(validHash, fakeFetch)).rejects.toThrow(
      /did not return an array/,
    );
  });
});
