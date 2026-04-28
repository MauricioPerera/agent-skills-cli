// CMS / X.509 walker for Sigstore identity extraction (v0.16.0+).
//
// A "sigstore"-method tag carries a CMS SignedData blob whose first cert is
// the Fulcio-issued ephemeral signing cert. That cert's Subject Alternative
// Name (SAN) carries the OIDC subject (typically an email for human signers
// or a workflow URI for GitHub Actions), and the Fulcio extension at
// OID 1.3.6.1.4.1.57264.1.1 (v1) / .1.8 (v2) carries the OIDC issuer.
// Together they answer "who actually signed this?", which is the *whole*
// point of Sigstore — short-lived certs replace long-lived signing keys, so
// the identity claim is the trust anchor.
//
// This file walks just enough ASN.1 to pull those two values out. We do NOT
// verify anything here — no chain validation, no Rekor lookup. Identity
// extraction is informational; it tells the operator who the publisher
// claimed to be at signing time. Verifying that claim against Rekor is
// Level 4 work and stays queued.
//
// Why hand-rolled instead of node-forge or similar? Three reasons:
//   1. Zero new deps. The reference CLI's dep list (ajv, ajv-formats, yaml)
//      stays minimal, which matters for the eventual npm publish.
//   2. The cross-impl Python proof needs the same logic; matching shape on
//      both sides keeps parity reasoning trivial.
//   3. We need ~5% of CMS — just the path to the first cert. A full CMS
//      parser would be ~10x the code with no extra value.

import { X509Certificate } from "node:crypto";

/** Result of extracting the Sigstore identity claim from a CMS payload. */
export interface SigstoreIdentity {
  /**
   * OIDC subject pulled from the cert's first SAN.
   *   - For human signers: the email (e.g., "billy@chainguard.dev").
   *   - For GitHub Actions: the workflow URI
   *     (e.g., "https://github.com/<org>/<repo>/.github/workflows/<file>@<ref>").
   */
  subject: string;
  /** SAN type prefix (Node's X509Certificate.subjectAltName format). */
  subject_type: "email" | "uri" | "other";
  /**
   * OIDC issuer URL from Fulcio extension 1.3.6.1.4.1.57264.1.1 (v1) or
   * 1.3.6.1.4.1.57264.1.8 (v2). Examples:
   *   - "https://accounts.google.com" (Google OAuth)
   *   - "https://github.com/login/oauth" (GitHub user OAuth)
   *   - "https://token.actions.githubusercontent.com" (GitHub Actions OIDC)
   * Undefined when the extension is missing.
   */
  issuer?: string;
}

/** Minimal ASN.1 DER TLV reader. */
interface TLV {
  tag: number;
  headerLen: number;
  valueLen: number;
  valueOff: number;
  totalLen: number;
}

const readTLV = (buf: Uint8Array, off: number): TLV => {
  if (off + 2 > buf.length) throw new Error("ASN.1 truncated at TLV header");
  const tag = buf[off]!;
  let p = off + 1;
  let len = buf[p++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new Error("ASN.1 indefinite length not supported (CMS uses DER)");
    if (n > 4) throw new Error(`ASN.1 length-of-length ${n} unreasonable`);
    if (p + n > buf.length) throw new Error("ASN.1 truncated in length bytes");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++]!;
  }
  if (p + len > buf.length) throw new Error("ASN.1 declared length exceeds buffer");
  return { tag, headerLen: p - off, valueLen: len, valueOff: p, totalLen: p - off + len };
};

/** Decode a DER OID value into dotted-decimal string. */
const decodeOID = (buf: Uint8Array): string => {
  if (buf.length === 0) return "";
  const out: number[] = [];
  const first = buf[0]!;
  out.push(Math.floor(first / 40));
  out.push(first % 40);
  let v = 0;
  for (let i = 1; i < buf.length; i++) {
    v = (v << 7) | (buf[i]! & 0x7f);
    if ((buf[i]! & 0x80) === 0) {
      out.push(v);
      v = 0;
    }
  }
  return out.join(".");
};

const PEM_OPEN = "-----BEGIN SIGNED MESSAGE-----";
const PEM_CLOSE = "-----END SIGNED MESSAGE-----";
const FULCIO_OIDC_ISSUER_OID_V1 = "1.3.6.1.4.1.57264.1.1";
const FULCIO_OIDC_ISSUER_OID_V2 = "1.3.6.1.4.1.57264.1.8";

/**
 * Extract the first X.509 cert's DER bytes from a CMS SignedData PEM blob.
 * Returns null on malformed input rather than throwing — callers treat
 * extraction failure as "identity unknown", same as a missing payload.
 */
const extractFirstCertDer = (pemSignature: string): Uint8Array | null => {
  // 1. Strip PEM frame.
  const start = pemSignature.indexOf(PEM_OPEN);
  if (start < 0) return null;
  const end = pemSignature.indexOf(PEM_CLOSE, start + PEM_OPEN.length);
  if (end < 0) return null;
  const b64 = pemSignature.slice(start + PEM_OPEN.length, end).replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    der = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (der.length === 0) return null;

  try {
    // 2. ContentInfo SEQUENCE → skip OID → enter [0] EXPLICIT.
    const ci = readTLV(der, 0);
    if (ci.tag !== 0x30) return null;
    let off = ci.valueOff;
    const oid = readTLV(der, off);
    off += oid.totalLen;
    const explicit = readTLV(der, off);
    if (explicit.tag !== 0xa0) return null;

    // 3. Inside [0]: SignedData SEQUENCE.
    const sd = readTLV(der, explicit.valueOff);
    if (sd.tag !== 0x30) return null;

    // 4. Walk SignedData children to find [0] IMPLICIT certificates (tag 0xa0).
    let p = sd.valueOff;
    const sdEnd = sd.valueOff + sd.valueLen;
    let certSet: TLV | null = null;
    while (p < sdEnd) {
      const t = readTLV(der, p);
      if (t.tag === 0xa0) {
        certSet = t;
        break;
      }
      p += t.totalLen;
    }
    if (!certSet) return null;

    // 5. First child of certificates SET = X.509 cert SEQUENCE in DER.
    const cert = readTLV(der, certSet.valueOff);
    if (cert.tag !== 0x30) return null;
    return der.subarray(certSet.valueOff, certSet.valueOff + cert.totalLen);
  } catch {
    return null;
  }
};

/**
 * Walk a parsed X.509 cert's TBS to find the first matching extension's
 * inner UTF-8 value. Used to read the Fulcio OIDC-issuer extension.
 *
 * Returns the raw OCTET STRING contents — for OID .1.1 the value is bare
 * UTF-8, for .1.8 the value is a UTF8String-wrapped DER blob.
 */
const findExtensionUtf8 = (certDer: Uint8Array, oids: readonly string[]): string | undefined => {
  try {
    const cert = readTLV(certDer, 0);
    const tbs = readTLV(certDer, cert.valueOff);
    let p = tbs.valueOff;
    const tbsEnd = tbs.valueOff + tbs.valueLen;
    // Find [3] EXPLICIT extensions (tag 0xa3).
    let extOuter: TLV | null = null;
    while (p < tbsEnd) {
      const t = readTLV(certDer, p);
      if (t.tag === 0xa3) {
        extOuter = t;
        break;
      }
      p += t.totalLen;
    }
    if (!extOuter) return undefined;

    const extSeq = readTLV(certDer, extOuter.valueOff);
    if (extSeq.tag !== 0x30) return undefined;

    let ep = extSeq.valueOff;
    const eEnd = extSeq.valueOff + extSeq.valueLen;
    while (ep < eEnd) {
      const ext = readTLV(certDer, ep);
      let ip = ext.valueOff;
      const oidT = readTLV(certDer, ip);
      const oid = decodeOID(certDer.subarray(oidT.valueOff, oidT.valueOff + oidT.valueLen));
      ip += oidT.totalLen;
      // Skip optional critical BOOLEAN.
      let valT = readTLV(certDer, ip);
      if (valT.tag === 0x01) {
        ip += valT.totalLen;
        valT = readTLV(certDer, ip);
      }
      if (valT.tag === 0x04 && oids.includes(oid)) {
        const inner = certDer.subarray(valT.valueOff, valT.valueOff + valT.valueLen);
        // V2 extension wraps the value in a UTF8String DER (tag 0x0c); V1 is bare bytes.
        if (oid === FULCIO_OIDC_ISSUER_OID_V2 && inner.length > 0 && inner[0] === 0x0c) {
          const utf8 = readTLV(inner, 0);
          return Buffer.from(inner.subarray(utf8.valueOff, utf8.valueOff + utf8.valueLen)).toString("utf8");
        }
        return Buffer.from(inner).toString("utf8");
      }
      ep += ext.totalLen;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Parse an X509Certificate subjectAltName string of the form
 * "email:foo@bar, URI:https://..." and return the first entry's
 * type + value. Format is documented at
 * https://nodejs.org/api/crypto.html#x509certsubjectaltname.
 */
const parseFirstSAN = (san: string): { subject: string; subject_type: SigstoreIdentity["subject_type"] } | null => {
  const trimmed = san.trim();
  if (trimmed.length === 0) return null;
  // First entry only (Sigstore certs typically carry one).
  const firstComma = trimmed.indexOf(", ");
  const first = firstComma >= 0 ? trimmed.slice(0, firstComma) : trimmed;
  const colon = first.indexOf(":");
  if (colon < 0) return { subject: first, subject_type: "other" };
  const prefix = first.slice(0, colon).toLowerCase();
  const value = first.slice(colon + 1);
  if (prefix === "email") return { subject: value, subject_type: "email" };
  if (prefix === "uri") return { subject: value, subject_type: "uri" };
  return { subject: value, subject_type: "other" };
};

/**
 * Top-level entry point: given a CMS-armored signature payload, extract the
 * Sigstore identity (subject from SAN + issuer from Fulcio extension).
 *
 * Returns undefined when the input isn't a Sigstore signature, parsing
 * fails, or the cert has no SAN. Never throws on malformed input.
 *
 * IMPORTANT: extraction != verification. The returned identity is what the
 * cert *claims*; verifying that claim against Rekor (so an attacker can't
 * forge a cert with arbitrary SAN values) is Level 4 work and ships
 * separately.
 */
export const extractSigstoreIdentity = (
  pemSignature: string | null | undefined,
): SigstoreIdentity | undefined => {
  if (typeof pemSignature !== "string" || pemSignature.length === 0) return undefined;
  const certDer = extractFirstCertDer(pemSignature);
  if (!certDer) return undefined;

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certDer);
  } catch {
    return undefined;
  }

  const san = cert.subjectAltName;
  if (!san) return undefined;
  const parsed = parseFirstSAN(san);
  if (!parsed) return undefined;

  const issuer = findExtensionUtf8(certDer, [FULCIO_OIDC_ISSUER_OID_V1, FULCIO_OIDC_ISSUER_OID_V2]);

  return {
    subject: parsed.subject,
    subject_type: parsed.subject_type,
    ...(issuer !== undefined ? { issuer } : {}),
  };
};
