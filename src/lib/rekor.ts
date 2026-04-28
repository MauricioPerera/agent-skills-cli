// Rekor entry parsing — preparation for client-side Level 4 verification.
//
// SCOPE NOTE (v0.17.0): this module only PARSES Rekor responses into typed
// shapes. It does NOT verify inclusion proofs, checkpoint signatures, or the
// Fulcio cert chain. That's Level 4 work and is queued for v0.18+. Parsing
// without verification is still useful — operators can inspect what Rekor
// CLAIMS about an entry (logIndex, integratedTime, the artifact hash, the
// signing cert) and cross-reference it against `provenance.signature_identity`
// from v0.16. Cross-impl Python parity is also deferred to v0.18 since
// parsing is cheap to mirror once the verification crypto comes with it.
//
// Why not just ship verification today? Two reasons spelled out in the
// release-notes:
//   1. Rekor's checkpoint format is C2SP "signed note" (4-byte key hint +
//      ECDSA P-256 signature over a specific body framing). Easy to get
//      wrong, and a wrong verifier is *worse* than no verifier — it tells
//      operators "this is verified" on forged inputs.
//   2. The responsible alternative is `@sigstore/verify` (audited, official
//      Sigstore project). Adopting it is a meaningful dep posture change
//      that wants explicit consideration, not a drive-by.
//
// What IS shipped here:
//   - parseRekorEntry: strict typed parsing of the API response shape
//   - decodeRekorBody: base64-decode the body field into a hashedrekord
//   - fetchRekorEntry: by UUID, via Rekor's public API
//   - Rekor public-instance host pinning (rekor.sigstore.dev)

import { CliError, EXIT } from "./errors.js";

/**
 * The public Sigstore Rekor instance. Pinned here so a misconfigured Rekor
 * URL can't silently downgrade Level 4 verification to "trust some random
 * server".
 */
export const REKOR_PUBLIC_HOST = "https://rekor.sigstore.dev";

/**
 * The hashedrekord body decoded from the entry's `body` field (base64).
 * v0.17 ships the 0.0.1 schema only; other Rekor entry kinds (intoto,
 * dsse, etc.) are out of scope until verification work needs them.
 */
export interface RekorHashedrekordBody {
  apiVersion: string;
  kind: "hashedrekord";
  spec: {
    data: {
      hash: {
        algorithm: "sha256";
        value: string; // hex-encoded 32-byte digest
      };
    };
    signature: {
      content: string; // base64 DER-encoded ECDSA signature
      publicKey: {
        content: string; // base64 PEM-encoded X.509 cert (Fulcio-issued for Sigstore)
      };
    };
  };
}

/**
 * The inclusion proof shape Rekor returns. Note this is a DYNAMIC proof:
 * Rekor generates it against the current tree state at fetch time, so two
 * lookups of the same UUID seconds apart will return different `treeSize`,
 * `rootHash`, and `hashes` values for the same entry. The entry itself
 * (logIndex, integratedTime, body) is immutable.
 *
 * Verifiers MUST treat the proof as a snapshot: compute the root from
 * (entryHash + hashes path) and compare against the claimed `rootHash`,
 * then verify `checkpoint` is signed by Rekor's pubkey, then check that
 * `checkpoint`'s tree size matches `treeSize` (and that `treeSize` is
 * monotonically non-decreasing across observed fetches).
 */
export interface RekorInclusionProof {
  /**
   * Position of this entry within ITS LOCAL TREE (i.e., the shard identified
   * by `entry.logID`), 0-based.
   *
   * ⚠ This is NOT the same as `RekorEntry.logIndex`. Rekor shards across
   * multiple trees, and the entry's outer `logIndex` is the global index
   * across ALL shards (monotonic, never resets), while this field is the
   * position within the tree the inclusion proof is computed against. The
   * Merkle math operates on the local tree, so a v0.18 verifier MUST use
   * THIS field (not the outer one) when computing leaf-to-root paths.
   */
  logIndex: number;
  /**
   * Total size of THIS shard's tree at the moment the proof was generated.
   * Same caveat as the local logIndex: not the global Rekor entry count.
   */
  treeSize: number;
  /** Base64-encoded SHA-256 root hash at that tree size. */
  rootHash: string;
  /** Audit path: array of base64-encoded sibling hashes from leaf to root. */
  hashes: string[];
  /**
   * Signed tree head in C2SP signed-note format (lines: origin / size /
   * root-base64 / blank / signature-line). Verifiers parse this to extract
   * the signature and verify against Rekor's pinned ECDSA P-256 pubkey.
   * Format reference: https://c2sp.org/signed-note
   */
  checkpoint: string;
}

/** A single entry as Rekor returns it from /api/v1/log/entries/<uuid>. */
export interface RekorEntry {
  /** Entry UUID — also the key in the API's outer object response. */
  uuid: string;
  /** Position of this entry in the global Rekor log. Immutable. */
  logIndex: number;
  /** Unix epoch seconds when Rekor accepted the entry. Immutable. */
  integratedTime: number;
  /** Hex-encoded log shard ID. Useful when multiple shards exist. */
  logID: string;
  /** The hashedrekord body, base64 decoded and parsed. */
  body: RekorHashedrekordBody;
  /**
   * The inclusion proof for THIS fetch. Dynamic — re-fetching produces a
   * different proof against a newer tree size. v0.17 surfaces but doesn't
   * verify it (see SCOPE NOTE at top of file).
   */
  inclusionProof: RekorInclusionProof;
}

/**
 * Type guard: returns true iff `value` looks like a hashedrekord body shape.
 * We're strict because parse failures here defang downstream verification.
 */
const isHashedrekordBody = (value: unknown): value is RekorHashedrekordBody => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== "hashedrekord") return false;
  if (typeof v.apiVersion !== "string") return false;
  const spec = v.spec as Record<string, unknown> | undefined;
  if (!spec) return false;
  const data = spec.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const hash = data.hash as Record<string, unknown> | undefined;
  if (!hash) return false;
  if (hash.algorithm !== "sha256") return false;
  if (typeof hash.value !== "string") return false;
  const sig = spec.signature as Record<string, unknown> | undefined;
  if (!sig) return false;
  if (typeof sig.content !== "string") return false;
  const pk = sig.publicKey as Record<string, unknown> | undefined;
  if (!pk) return false;
  if (typeof pk.content !== "string") return false;
  return true;
};

/**
 * Parse Rekor's `/api/v1/log/entries/{uuid}` JSON response into a typed
 * RekorEntry. The API returns `{ "<uuid>": { logIndex, integratedTime, ... } }`
 * (a single-entry object keyed by UUID); we unwrap it.
 *
 * Throws CliError on malformed input — we'd rather fail loudly than silently
 * produce a partial structure that downstream verification might misread.
 */
export const parseRekorEntry = (apiResponse: unknown): RekorEntry => {
  if (!apiResponse || typeof apiResponse !== "object") {
    throw new CliError(EXIT.RUNTIME, "rekor: response is not an object");
  }
  const entries = Object.entries(apiResponse as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new CliError(
      EXIT.RUNTIME,
      `rekor: expected single-entry response, got ${entries.length} entries`,
    );
  }
  const [uuid, raw] = entries[0]!;
  if (!uuid || typeof uuid !== "string") {
    throw new CliError(EXIT.RUNTIME, "rekor: missing entry UUID");
  }
  if (!raw || typeof raw !== "object") {
    throw new CliError(EXIT.RUNTIME, "rekor: entry value is not an object");
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.logIndex !== "number") {
    throw new CliError(EXIT.RUNTIME, "rekor: missing or invalid logIndex");
  }
  if (typeof e.integratedTime !== "number") {
    throw new CliError(EXIT.RUNTIME, "rekor: missing or invalid integratedTime");
  }
  if (typeof e.logID !== "string") {
    throw new CliError(EXIT.RUNTIME, "rekor: missing or invalid logID");
  }
  if (typeof e.body !== "string") {
    throw new CliError(EXIT.RUNTIME, "rekor: missing body (base64 string expected)");
  }

  let bodyDecoded: unknown;
  try {
    bodyDecoded = JSON.parse(Buffer.from(e.body, "base64").toString("utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `rekor: body is not valid base64-encoded JSON: ${msg}`);
  }
  if (!isHashedrekordBody(bodyDecoded)) {
    throw new CliError(
      EXIT.RUNTIME,
      "rekor: body is not a recognised hashedrekord (v0.17 supports kind=hashedrekord/v0.0.1 only; intoto/dsse pending)",
    );
  }

  const verification = e.verification as Record<string, unknown> | undefined;
  const proofRaw = verification?.inclusionProof as Record<string, unknown> | undefined;
  if (!proofRaw) {
    throw new CliError(EXIT.RUNTIME, "rekor: entry missing verification.inclusionProof");
  }
  if (typeof proofRaw.logIndex !== "number") {
    throw new CliError(EXIT.RUNTIME, "rekor: inclusionProof missing logIndex");
  }
  if (typeof proofRaw.treeSize !== "number") {
    throw new CliError(EXIT.RUNTIME, "rekor: inclusionProof missing treeSize");
  }
  if (typeof proofRaw.rootHash !== "string") {
    throw new CliError(EXIT.RUNTIME, "rekor: inclusionProof missing rootHash");
  }
  if (typeof proofRaw.checkpoint !== "string") {
    throw new CliError(EXIT.RUNTIME, "rekor: inclusionProof missing checkpoint");
  }
  if (!Array.isArray(proofRaw.hashes)) {
    throw new CliError(EXIT.RUNTIME, "rekor: inclusionProof.hashes is not an array");
  }
  for (const h of proofRaw.hashes) {
    if (typeof h !== "string") {
      throw new CliError(EXIT.RUNTIME, "rekor: inclusionProof.hashes contains non-string");
    }
  }

  return {
    uuid,
    logIndex: e.logIndex,
    integratedTime: e.integratedTime,
    logID: e.logID,
    body: bodyDecoded,
    inclusionProof: {
      logIndex: proofRaw.logIndex,
      treeSize: proofRaw.treeSize,
      rootHash: proofRaw.rootHash,
      hashes: proofRaw.hashes as string[],
      checkpoint: proofRaw.checkpoint,
    },
  };
};

/**
 * Fetch a single Rekor entry by UUID from the public Sigstore instance.
 *
 * Returns the parsed RekorEntry. The fetch path is:
 *   GET https://rekor.sigstore.dev/api/v1/log/entries/{uuid}
 *
 * Note: the inclusion proof returned is a snapshot against Rekor's
 * tree state at the time of THIS fetch. Re-fetching yields a different
 * proof for the same entry. Callers that want a stable proof for offline
 * verification must persist the response immediately.
 */
export const fetchRekorEntry = async (
  uuid: string,
  fetchImpl: typeof fetch = fetch,
  host: string = REKOR_PUBLIC_HOST,
): Promise<RekorEntry> => {
  if (!/^[a-f0-9]+$/i.test(uuid) || uuid.length < 16 || uuid.length > 128) {
    throw new CliError(EXIT.VALIDATION, `rekor: invalid entry UUID '${uuid}'`);
  }
  const url = `${host}/api/v1/log/entries/${uuid}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.RUNTIME, `rekor: fetch failed for ${url}: ${msg}`);
  }
  if (res.status === 404) {
    throw new CliError(EXIT.RUNTIME, `rekor: entry '${uuid}' not found at ${host}`);
  }
  if (!res.ok) {
    throw new CliError(
      EXIT.RUNTIME,
      `rekor: ${url} returned ${res.status} ${res.statusText}`,
    );
  }
  const json = await res.json();
  return parseRekorEntry(json);
};
