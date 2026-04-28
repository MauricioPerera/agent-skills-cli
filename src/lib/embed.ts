// Embedding provider abstraction. Conformant skill banks may use any model
// they choose; the spec (SPEC.md §4.2) only requires that the same model is
// used at indexing time and at query time. This module defines the provider
// interface and ships two implementations: Cloudflare Workers AI (default)
// and a stub for tests.

import { CliError, EXIT } from "./errors.js";

export interface EmbeddingProvider {
  /** Stable identifier including the model name. Stored on each indexed skill so banks can detect mismatch. */
  readonly name: string;
  /** Output dimensionality of the model. */
  readonly dim: number;
  /** Compute the embedding vector for a single text input. */
  embed(text: string): Promise<number[]>;
}

// Cloudflare Workers AI — known embedding models with their dimensions.
// Source: https://developers.cloudflare.com/workers-ai/models/?task=Text+Embeddings
const CF_MODEL_DIMS: Record<string, number> = {
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
  "@cf/google/embeddinggemma-300m": 768,
};

export interface CloudflareEmbedderConfig {
  /** Cloudflare account ID (32 hex chars). */
  accountId: string;
  /** API token with Workers AI permission. */
  apiToken: string;
  /** Model identifier. Default: @cf/baai/bge-base-en-v1.5 (768-dim, free tier). */
  model?: string;
  /** Optional custom fetch (for testing). */
  fetchFn?: typeof fetch;
}

/**
 * Create an embedding provider backed by Cloudflare Workers AI's REST API.
 *
 * Auth: the account ID + API token are passed at construction. They are NOT
 * read from the environment automatically — that's the CLI's responsibility,
 * keeping this lib pure.
 *
 * The token never appears in any error message thrown by this module.
 */
export const createCloudflareEmbedder = (
  config: CloudflareEmbedderConfig,
): EmbeddingProvider => {
  if (!/^[a-f0-9]{32}$/.test(config.accountId)) {
    throw new CliError(EXIT.USAGE, `invalid Cloudflare account ID format`);
  }
  if (config.apiToken.length === 0) {
    throw new CliError(EXIT.USAGE, "Cloudflare API token is empty");
  }

  const model = config.model ?? "@cf/baai/bge-base-en-v1.5";
  const dim = CF_MODEL_DIMS[model];
  if (dim === undefined) {
    throw new CliError(
      EXIT.USAGE,
      `unknown Cloudflare embedding model '${model}'. Known: ${Object.keys(CF_MODEL_DIMS).join(", ")}`,
    );
  }

  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${model}`;

  return {
    name: `cloudflare:${model}`,
    dim,
    async embed(text: string): Promise<number[]> {
      if (text.length === 0) {
        throw new CliError(EXIT.USAGE, "cannot embed empty text");
      }

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(EXIT.RUNTIME, `Cloudflare AI request failed: ${msg}`);
      }

      if (!res.ok) {
        // Read body but never include the auth token in error messages.
        let body = "";
        try {
          body = await res.text();
        } catch {
          // ignore
        }
        throw new CliError(
          EXIT.RUNTIME,
          `Cloudflare AI returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as {
        result?: { data?: number[][]; shape?: number[] };
        success?: boolean;
        errors?: unknown[];
      };

      if (json.success === false) {
        throw new CliError(
          EXIT.RUNTIME,
          `Cloudflare AI returned errors: ${JSON.stringify(json.errors)}`,
        );
      }

      const vec = json.result?.data?.[0];
      if (!Array.isArray(vec)) {
        throw new CliError(
          EXIT.RUNTIME,
          "Cloudflare AI response missing result.data[0] (embedding vector)",
        );
      }
      if (vec.length !== dim) {
        throw new CliError(
          EXIT.RUNTIME,
          `Cloudflare AI returned ${vec.length}-dim vector; expected ${dim} for model ${model}`,
        );
      }

      return vec;
    },
  };
};

/**
 * Stub provider for testing. Hashes the input text deterministically into a
 * fixed-dim vector. Same text → same vector → reproducible tests.
 *
 * Uses a simple FNV-1a hash to spread bytes across the vector.
 */
export const createStubEmbedder = (dim = 32): EmbeddingProvider => {
  return {
    name: `stub:fnv1a-${dim}`,
    dim,
    async embed(text: string): Promise<number[]> {
      const vec = new Array<number>(dim).fill(0);
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
        vec[i % dim] = ((vec[i % dim] ?? 0) + (h & 0xff) / 0xff) % 1;
      }
      // L2-normalize so cosine similarity is well-behaved
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      return vec.map((v) => v / norm);
    },
  };
};

/**
 * Compose the embedding text per SPEC.md §4.2.
 *
 *   1. title
 *   2. use_when
 *   3. description
 *   4. examples[].intent (joined by \n)
 *   5. tags (joined by space)
 *
 * Sections joined by ". " (period + space).
 */
export const composeEmbeddingText = (fm: {
  title: string;
  use_when: string;
  description: string;
  examples?: Array<{ intent: string }>;
  tags?: string[];
}): string => {
  const parts: string[] = [fm.title, fm.use_when, fm.description];

  if (fm.examples && fm.examples.length > 0) {
    parts.push(fm.examples.map((e) => e.intent).join("\n"));
  }

  if (fm.tags && fm.tags.length > 0) {
    parts.push(fm.tags.join(" "));
  }

  return parts.join(". ");
};

/**
 * Cosine similarity between two equal-length vectors. Range: [-1, 1].
 * Higher = more similar.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
};
