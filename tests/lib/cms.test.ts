import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { extractSigstoreIdentity } from "../../src/lib/cms.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../fixtures/gitsign-v0.14.0-verification.json");

interface VerificationFixture {
  signature: string;
  payload: string;
  reason: string;
  verified: boolean;
}

const loadGitsignFixture = (): VerificationFixture =>
  JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as VerificationFixture;

describe("extractSigstoreIdentity — real sigstore/gitsign@v0.14.0 payload", () => {
  // The fixture is the actual GitHub API response for sigstore/gitsign's
  // v0.14.0 tag (a known-good Sigstore signature whose Fulcio cert has since
  // expired — perfect for testing identity extraction independently of
  // host-side verification verdicts).

  it("returns the OIDC subject from the cert SAN", () => {
    const { signature } = loadGitsignFixture();
    const identity = extractSigstoreIdentity(signature);
    expect(identity).toBeDefined();
    expect(identity!.subject).toBe("billy@chainguard.dev");
    expect(identity!.subject_type).toBe("email");
  });

  it("returns the OIDC issuer from the Fulcio extension (1.3.6.1.4.1.57264.1.1)", () => {
    const { signature } = loadGitsignFixture();
    const identity = extractSigstoreIdentity(signature);
    expect(identity!.issuer).toBe("https://accounts.google.com");
  });

  it("never throws on the real payload (parse-then-return contract)", () => {
    const { signature } = loadGitsignFixture();
    expect(() => extractSigstoreIdentity(signature)).not.toThrow();
  });
});

describe("extractSigstoreIdentity — defensive paths", () => {
  it("returns undefined for null / undefined / empty", () => {
    expect(extractSigstoreIdentity(null)).toBeUndefined();
    expect(extractSigstoreIdentity(undefined)).toBeUndefined();
    expect(extractSigstoreIdentity("")).toBeUndefined();
  });

  it("returns undefined for non-Sigstore PEM payloads", () => {
    const gpgSig = `-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----`;
    expect(extractSigstoreIdentity(gpgSig)).toBeUndefined();
    const sshSig = `-----BEGIN SSH SIGNATURE-----\nfake\n-----END SSH SIGNATURE-----`;
    expect(extractSigstoreIdentity(sshSig)).toBeUndefined();
  });

  it("returns undefined for malformed CMS (well-framed but garbage body)", () => {
    const garbage = `-----BEGIN SIGNED MESSAGE-----\nQUFBQUFB\n-----END SIGNED MESSAGE-----`;
    // Does not throw, returns undefined per the parse-then-return contract.
    expect(() => extractSigstoreIdentity(garbage)).not.toThrow();
    expect(extractSigstoreIdentity(garbage)).toBeUndefined();
  });

  it("returns undefined when PEM end marker is missing", () => {
    const partial = `-----BEGIN SIGNED MESSAGE-----\nQUFB`;
    expect(extractSigstoreIdentity(partial)).toBeUndefined();
  });

  it("returns undefined for invalid base64", () => {
    const badB64 = `-----BEGIN SIGNED MESSAGE-----\n!!!not-base64!!!\n-----END SIGNED MESSAGE-----`;
    expect(extractSigstoreIdentity(badB64)).toBeUndefined();
  });
});
