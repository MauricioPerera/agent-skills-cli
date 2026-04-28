import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { extractSigstoreIdentity, computeGitsignRekorLookupHash } from "../../src/lib/cms.js";
import { createHash } from "node:crypto";

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

// ────────────────────────────────────────────────────────────────────
// computeGitsignRekorLookupHash — gitsign-flavor Rekor lookup hash
// ────────────────────────────────────────────────────────────────────

describe("computeGitsignRekorLookupHash — real gitsign payload", () => {
  // The hash a Level 4 verifier uses to locate the Rekor entry for a
  // gitsign-signed git tag. gitsign hashes the SignerInfo's SignedAttrs
  // marshaled-for-verification (RFC 5652 §5.4) — NOT the raw signed
  // payload. See SPEC §5.4.2 step 3 for the framing rationale.

  it("returns a stable 64-char lower-case hex digest for a real gitsign payload", () => {
    const { signature } = loadGitsignFixture();
    const hash = computeGitsignRekorLookupHash(signature);
    expect(hash).toBeDefined();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Bit-stable across runs of the same input.
    expect(computeGitsignRekorLookupHash(signature)).toBe(hash);
  });

  it("matches the value produced by the reference prototype (regression lock)", () => {
    // Computed during v0.17.1 development by hand-walking the CMS payload
    // and re-tagging signedAttrs as SET (0x31). If this value drifts, the
    // walker logic has changed in a way that would silently break Rekor
    // lookups — fail loud before that ships.
    const { signature } = loadGitsignFixture();
    expect(computeGitsignRekorLookupHash(signature)).toBe(
      "393d4b96fe4e0eae0fc313f5f8947c2a9782f189604d9f47ba7a66c709f2326e",
    );
  });

  it("structural invariant: messageDigest in SignedAttrs == SHA-256(payload)", () => {
    // This is the property that proves the framing is correct WITHOUT
    // needing a live Rekor entry. Per RFC 5652 §11.2: SignedAttrs MUST
    // contain a messageDigest attribute whose value is the digest of the
    // signed content. If our walk reaches the right SignedAttrs bytes,
    // decoding the messageDigest attribute MUST yield SHA-256(payload).
    //
    // This is white-box: we re-implement enough of the walker here to
    // pull the messageDigest out and compare. Catches a class of regressions
    // where the SignedAttrs walk silently lands on the wrong bytes.
    const { signature, payload } = loadGitsignFixture();

    // Re-extract SignedAttrs the same way computeGitsignRekorLookupHash does.
    const m = signature.match(
      /-----BEGIN SIGNED MESSAGE-----\s*([\s\S]*?)\s*-----END SIGNED MESSAGE-----/,
    )!;
    const der = Buffer.from(m[1]!.replace(/\s+/g, ""), "base64");
    const rd = (buf: Buffer, off: number) => {
      const tag = buf[off]!;
      let p = off + 1;
      let len = buf[p++]!;
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = (len << 8) | buf[p++]!;
      }
      return { tag, valueOff: p, valueLen: len, totalLen: p - off + len };
    };
    const ci = rd(der, 0);
    let off = ci.valueOff;
    off += rd(der, off).totalLen; // skip OID
    const ex = rd(der, off);
    const sd = rd(der, ex.valueOff);
    let p = sd.valueOff;
    const sdEnd = sd.valueOff + sd.valueLen;
    let signerInfos: ReturnType<typeof rd> | null = null;
    while (p < sdEnd) {
      const t = rd(der, p);
      if (t.tag === 0x31) signerInfos = t;
      p += t.totalLen;
    }
    const si = rd(der, signerInfos!.valueOff);
    let sip = si.valueOff;
    const siEnd = si.valueOff + si.valueLen;
    let sa: ReturnType<typeof rd> | null = null;
    while (sip < siEnd) {
      const t = rd(der, sip);
      if (t.tag === 0xa0) {
        sa = t;
        break;
      }
      sip += t.totalLen;
    }
    expect(sa).not.toBeNull();

    // Walk Attributes inside SignedAttrs to find OID 1.2.840.113549.1.9.4 (messageDigest).
    const inner = der.subarray(sa!.valueOff, sa!.valueOff + sa!.valueLen);
    let ip = 0;
    let messageDigest: Buffer | null = null;
    while (ip < inner.length) {
      const attr = rd(inner as Buffer, ip);
      let aip = attr.valueOff;
      const oidT = rd(inner as Buffer, aip);
      // Quick OID matcher: messageDigest = {1.2.840.113549.1.9.4}.
      const oidBytes = Buffer.from(
        inner.subarray(oidT.valueOff, oidT.valueOff + oidT.valueLen),
      );
      const expected = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]);
      aip += oidT.totalLen;
      const valSet = rd(inner as Buffer, aip);
      const valInner = rd(inner as Buffer, valSet.valueOff);
      if (oidBytes.equals(expected)) {
        messageDigest = Buffer.from(
          inner.subarray(valInner.valueOff, valInner.valueOff + valInner.valueLen),
        );
        break;
      }
      ip += attr.totalLen;
    }
    expect(messageDigest).not.toBeNull();

    // The invariant: messageDigest bytes == SHA-256(payload).
    const payloadDigest = createHash("sha256").update(payload).digest();
    expect(messageDigest!.equals(payloadDigest)).toBe(true);
  });

  it("returns undefined for non-Sigstore PEM payloads", () => {
    const gpgSig = `-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----`;
    expect(computeGitsignRekorLookupHash(gpgSig)).toBeUndefined();
    const sshSig = `-----BEGIN SSH SIGNATURE-----\nfake\n-----END SSH SIGNATURE-----`;
    expect(computeGitsignRekorLookupHash(sshSig)).toBeUndefined();
  });

  it("returns undefined for null / undefined / empty / malformed inputs", () => {
    expect(computeGitsignRekorLookupHash(null)).toBeUndefined();
    expect(computeGitsignRekorLookupHash(undefined)).toBeUndefined();
    expect(computeGitsignRekorLookupHash("")).toBeUndefined();
    expect(
      computeGitsignRekorLookupHash(
        "-----BEGIN SIGNED MESSAGE-----\nQUFBQUFB\n-----END SIGNED MESSAGE-----",
      ),
    ).toBeUndefined();
  });

  it("never throws on malformed input (parse-then-return contract)", () => {
    expect(() => computeGitsignRekorLookupHash("garbage")).not.toThrow();
    expect(() =>
      computeGitsignRekorLookupHash(
        "-----BEGIN SIGNED MESSAGE-----\n!!!\n-----END SIGNED MESSAGE-----",
      ),
    ).not.toThrow();
  });
});
